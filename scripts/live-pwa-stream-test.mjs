#!/usr/bin/env node
/**
 * End-to-end test of the PWA's direct-stream input mode, in a real browser.
 *
 * Headless Chromium runs the production web build against a throwaway bridge
 * (scripts/e2e-harness.mjs). The test first switches Config → Voice & Controls
 * → Input mode to "Direct stream" through the UI, then taps the orb. Chrome's
 * fake microphone plays a WAV of speech-like phrases, so the page's own code
 * path is exercised: getUserMedia → the mic processing chain → 16 kHz PCM →
 * /ws/audio-stream → segmentation → the stand-in Whisper → the stub agent →
 * speak() back into the page.
 *
 * Needs Playwright (not a project dependency). Point at any install:
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/live-pwa-stream-test.mjs
 * or run it where `import('playwright')` resolves. Build first: npm run build.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const CANNED = ['check the build status', 'then open the changelog', 'thanks'];
const report = makeReporter();
const { say, check, fail } = report;

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = explicit ? await import(pathToFileURL(join(explicit, 'index.mjs')).href) : await import('playwright');
    return mod.chromium ?? mod.default?.chromium;
  } catch (err) {
    console.error(
      'Playwright not found — set PLAYWRIGHT_MODULE to a playwright package directory, ' +
        `or install it (npx playwright install chromium). ${err instanceof Error ? err.message : ''}`,
    );
    process.exit(2);
  }
}

const chromium = await loadPlaywright();
const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: CANNED,
  configure: (config) => {
    // Starts on turns (the default) — the UI switches it to stream below.
    // Browser speech output would try to speak in a headless shell with no voices.
    config.settings.voice.tts.agentVoiceEnabled = false;
  },
});

// Chrome loops the fake-capture file; two phrases then a long pause per loop.
const wavPath = join(av.tmp, 'mic.wav');
writeFileSync(
  wavPath,
  speechWav(
    [
      ['silence', 800],
      ['speech', 1400],
      ['silence', 1400],
      ['speech', 1100],
      ['silence', 6000],
    ],
    { rate: 48_000, channels: 1 },
  ),
);

let browser = null;
try {
  await av.startBridge();
  say(`bridge up at ${av.base}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(
    ({ token }) => {
      localStorage.setItem('cv_token', token);
      localStorage.setItem('cv_active_project', 'e2e');
    },
    { token: av.token },
  );
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));

  await page.goto(av.base, { waitUntil: 'networkidle' });

  // ── Switch to Direct stream through the Config screen ────────────────────
  const tab = (label) => page.locator('nav.cv-tabnav button', { hasText: label }).first();
  await tab('Config').click();
  await page.locator('button.cv-cfg-item', { hasText: 'Listening & controls' }).click();
  await page.getByText('Turns (recommended)').first().waitFor({ timeout: 10_000 });
  await page.getByText('Direct stream', { exact: true }).first().click();
  await page.getByText('Pause that ends a segment').first().waitFor({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Save input mode' }).click();
  let saved = null;
  for (let i = 0; i < 20 && saved?.inputMode !== 'stream'; i++) {
    await page.waitForTimeout(250);
    saved = JSON.parse((await av.api('/api/voice/providers')).text);
  }
  check(saved?.inputMode === 'stream', 'Config → Input mode saved "stream"', JSON.stringify(saved?.inputMode));
  check(saved?.stream?.segmentSilenceMs === 500, 'stream settings round-trip through the form', JSON.stringify(saved?.stream));
  // The "saved" toast sits over the tab bar — close it rather than click through it.
  for (const close of await page.locator('.p-toast .p-toast-close-button').all()) {
    await close.click().catch(() => undefined);
  }
  await page.locator('.p-toast-message').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  await tab('Voice').click();

  await page.locator('.cv-voice-orb-btn').first().waitFor({ timeout: 20_000 });
  say('PWA loaded — tapping the orb');
  await page.locator('.cv-voice-orb-btn').first().click();

  // Wait for both phrases to reach the stand-in Whisper and the agent to answer.
  const deadline = Date.now() + 45_000;
  let transcript = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    transcript = av.readNewest('transcripts');
    if (transcript.includes(`AGENT: ECHO stream: ${CANNED[1]}`)) break;
  }

  // Hang up (the live session hides the tab bar), then read the conversation on the Logs tab.
  await page.locator('.cv-voice-orb-btn').first().click();
  for (const close of await page.locator('.p-toast .p-toast-close-button').all()) {
    await close.click().catch(() => undefined);
  }
  await page.locator('nav.cv-tabnav button', { hasText: 'Logs' }).first().click({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const bodyText = await page.locator('body').innerText();
  say(`sockets: ${sockets.join(', ')}`);
  say(`stt calls: ${av.sttRequests.length}`);
  check(sockets.some((u) => u.endsWith('/ws/audio-stream')), 'the page opened /ws/audio-stream');
  check(sockets.some((u) => new URL(u).pathname === '/ws'), 'the page kept its /ws voice socket for replies');
  check(av.sttRequests.length >= 2, 'the fake mic was cut into segments and transcribed', `calls ${av.sttRequests.length}`);
  check(transcript.includes('phone (stream) started streaming'), 'transcript records the phone streaming');
  check(transcript.includes(`USER (stream): ${CANNED[0]}`), 'first phrase reached the agent');
  check(transcript.includes(`AGENT: ECHO boot: ${CANNED[0]}`), 'agent answered the first phrase');
  check(transcript.includes(`AGENT: ECHO stream: ${CANNED[1]}`), 'agent collected the second phrase as a stream turn');
  check(bodyText.includes(CANNED[0]), 'the Logs tab shows what was heard');
  check(bodyText.includes(`ECHO boot: ${CANNED[0]}`), 'the Logs tab shows the agent reply');

  const bridgeLog = av.readNewest('bridge');
  check(/audio stream started client="phone \(stream\)" listen=false/.test(bridgeLog), 'bridge logged the phone stream');

  if (report.failures) {
    await page.screenshot({ path: join(av.tmp, 'page.png'), fullPage: true });
    say(`screenshot: ${join(av.tmp, 'page.png')}`);
    say('browser console (last 30):');
    for (const line of consoleLines.slice(-30)) say(`    ${line}`);
  }
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  await browser?.close();
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — the PWA streams its mic to the agent' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
