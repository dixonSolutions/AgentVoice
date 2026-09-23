#!/usr/bin/env node
/**
 * End-to-end test of the direct audio stream pipe, session logs and transcripts.
 *
 * Everything that can be real is real:
 *
 *   agentvoice run / pipe / logs           the built CLI (or an installed one, --bin)
 *   the bridge                             a fresh bridge home, serve profile
 *   speech-to-text                         the real local_whisper provider over HTTP,
 *                                          pointed at a tiny OpenAI-compatible stand-in
 *   the voice agent                        scripts/stub-agent-cli.mjs as "Claude Code",
 *                                          over the real MCP transport, echoing each turn
 *
 * Only the model's judgement and Whisper's ears are scripted. HOME is a scratch
 * directory, so no real agent config (~/.claude.json …) is touched.
 *
 * Asserts:
 *   - audio (44.1 kHz stereo WAV, converted by the CLI) is cut into one segment per phrase
 *   - the first segment spawns the agent, the next is queued and collected with source=stream
 *   - the agent's replies come back down the pipe
 *   - a transcript file records the conversation, a bridge .log file records the session
 *   - later sessions gzip earlier sessions' files once they pile up
 *   - `agentvoice logs` shows the session log with no service unit, `--list`
 *     lists the files and `--cat` reads a .gz back
 *   - turn-based input from the phone socket still reaches the agent and is
 *     transcribed with its source
 *
 * Usage:
 *   npm run build:backend && node scripts/live-pipe-test.mjs [--bin agentvoice] [--keep]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const args = process.argv.slice(2);
const binFlag = args.indexOf('--bin');
const BIN = binFlag !== -1 ? [args[binFlag + 1]] : [process.execPath, join(ROOT, 'dist', 'cli.js')];
const KEEP = args.includes('--keep');
const CANNED = ['open the readme', 'and summarise it', 'one more thing'];

/** Impersonate the PWA on /ws/intelligence: send turns, collect what the agent says. */
async function phoneTurns(base, token, turns, expectSpeaks, timeoutMs = 30_000) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const seen = { authOk: null, speaks: [] };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_ok') {
        seen.authOk = msg;
        const [first, ...rest] = turns;
        ws.send(JSON.stringify({ type: 'user_turn', ...first }));
        seen.pending = rest;
      }
      if (msg.type === 'speak') {
        seen.speaks.push(msg.text);
        const next = seen.pending?.shift();
        if (next) setTimeout(() => ws.send(JSON.stringify({ type: 'user_turn', ...next })), 200);
        if (seen.speaks.length >= expectSpeaks) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      }
    });
  });
  return seen;
}

const report = makeReporter();
const { say, check, fail } = report;
const events = (stdout) =>
  stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

const av = await createInstance({ bin: BIN, canned: CANNED });

try {
  say(`scratch: ${av.tmp}`);
  say(`cli: ${BIN.join(' ')}`);

  const version = await av.run(['version']);
  check(version.code === 0 && /agentvoice \d/.test(version.stdout), 'agentvoice version', version.stdout + version.stderr);

  // ── session 1 ─────────────────────────────────────────────────────────
  await av.startBridge();
  say('bridge up');
  check((await av.api('/api/active-project', { project: 'e2e' })).status === 200, 'selected the project');
  const prep = await av.api('/api/voice-session/prepare', { project: 'e2e' });
  check(/"ok":true/.test(prep.text), 'MCP registration prepared', prep.text.slice(-300));
  check(existsSync(join(av.home, '.claude.json')), 'agent config went to the scratch HOME');

  const wavPath = join(av.tmp, 'speech.wav');
  writeFileSync(
    wavPath,
    speechWav([
      ['silence', 400],
      ['tone', 1200],
      ['silence', 1500],
      ['tone', 900],
      ['silence', 1500],
    ]),
  );
  const pipe = await av.run(['pipe', '--file', wavPath, '--realtime', '--json', '--name', 'e2e pipe', '--linger', '25'], {
    timeoutMs: 90_000,
  });
  const ev = events(pipe.stdout);
  const segs = ev.filter((e) => e.type === 'segment');
  const speaks = ev.filter((e) => e.type === 'speak').map((e) => e.text);
  say(`pipe exited ${pipe.code}; ${segs.length} segments; agent said: ${JSON.stringify(speaks)}`);
  check(pipe.code === 0, 'agentvoice pipe exits 0', pipe.stderr.slice(-800));
  check(ev.some((e) => e.type === 'ready' && e.listening === true), 'bridge accepted the stream');
  check(segs.length === 2, 'two phrases → two segments', `got ${segs.length}`);
  check(segs[0]?.text === CANNED[0] && segs[1]?.text === CANNED[1], 'segments transcribed in order');
  check(segs[0]?.delivery === 'spawn', 'first segment spawned the agent', segs[0]?.delivery);
  check(
    ['queued', 'waiter', 'tool_interrupt'].includes(segs[1]?.delivery),
    'second segment went to the running agent',
    segs[1]?.delivery,
  );
  check(av.sttRequests.length === 2, 'speech engine called once per segment', `calls ${av.sttRequests.length}`);
  check(av.sttRequests.every((r) => r.bytes > 20_000), 'segments reached the engine as audio', JSON.stringify(av.sttRequests));
  check(speaks.includes(`ECHO boot: ${CANNED[0]}`), 'agent heard the first segment in its boot prompt');
  check(speaks.includes(`ECHO stream: ${CANNED[1]}`), 'agent collected the next segment with source=stream');
  check(ev.some((e) => e.type === 'drained'), 'pipe drained cleanly');

  const transcripts1 = av.readFolder('transcripts');
  check(transcripts1.length === 1, 'one transcript file for the session', transcripts1.join(','));
  const tText = av.readNewest('transcripts');
  check(/^# AgentVoice voice transcript\n/.test(tText), 'transcript has a header');
  check(tText.includes('EVENT: e2e pipe connected'), 'transcript names the pipe');
  check(tText.includes(`USER (stream): ${CANNED[0]}`) && tText.includes(`USER (stream): ${CANNED[1]}`), 'transcript has both user segments');
  check(tText.includes(`AGENT: ECHO stream: ${CANNED[1]}`), 'transcript has the agent reply');
  check((tText.match(/Claude Code running/g) ?? []).length === 1, 'repeated status events written once');

  await av.stopBridge();
  say('bridge stopped');
  const bridge1 = av.readFolder('bridge');
  check(bridge1.length === 1 && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(_\d+)?\.log$/.test(bridge1[0] ?? ''), 'one date-named bridge log', bridge1.join(','));
  const bText = bridge1[0] ? readFileSync(join(av.logDir('bridge'), bridge1[0]), 'utf-8') : '';
  check(/^# AgentVoice bridge log\n/.test(bText), 'bridge log has a header');
  check(/runMode=serve/.test(bText) && /agent=claude-code/.test(bText), 'header describes the session');
  check(bText.includes('[config] config loaded'), 'boot lines before the logger started were kept');
  check(bText.includes('audio stream started') && bText.includes('stream segment transcribed'), 'pipe activity logged');
  check(/# session ended .*\(SIGTERM\)\n$/.test(bText), 'bridge log closed with a footer');
  check(!/\{"level":/.test(bText), 'log file is text, not JSON');

  // ── session 2 — the first session's bridge log is now compressed ─────────
  await av.startBridge();
  await new Promise((r) => setTimeout(r, 1500));
  const bridge2 = av.readFolder('bridge');
  check(
    bridge2.some((n) => n.endsWith('.log.gz')) && bridge2.filter((n) => n.endsWith('.log')).length === 1,
    'previous bridge log gzipped on startup',
    bridge2.join(','),
  );

  // Raw 16 kHz mono PCM on stdin: one phrase.
  const pcm = Buffer.alloc(16_000 * 2 * 3);
  for (let i = 0; i < 16_000; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 9000), (8_000 + i) * 2);
  const pipe2 = await av.run(['pipe', '--json', '--name', 'stdin pipe', '--linger', '10'], { input: pcm, timeoutMs: 60_000 });
  const ev2 = events(pipe2.stdout);
  check(pipe2.code === 0, 'stdin pipe exits 0', pipe2.stderr.slice(-500));
  check(ev2.some((e) => e.type === 'segment' && e.text === CANNED[2]), 'raw stdin PCM transcribed');
  await av.stopBridge();
  check(av.readFolder('transcripts').filter((n) => n.endsWith('.log')).length === 2, 'second session got its own transcript');

  // ── session 3 — startup compresses what piled up while shutting down ─────
  await av.startBridge();
  await new Promise((r) => setTimeout(r, 1500));
  const transcripts2 = av.readFolder('transcripts');
  check(
    transcripts2.filter((n) => n.endsWith('.log.gz')).length === 1 && transcripts2.filter((n) => n.endsWith('.log')).length === 1,
    'older transcript gzipped once a new one piled up',
    transcripts2.join(','),
  );
  check(!transcripts2.some((n) => n.includes('.partial')), 'no half-written archives');

  // ── turns still work: the phone socket ──────────────────────────────────
  const phone = await phoneTurns(av.base, av.token, [{ text: 'first phone turn' }, { text: 'phone follow up' }], 2);
  check(phone.authOk?.inputMode === 'turns', 'auth_ok announces the input mode', JSON.stringify(phone.authOk?.inputMode));
  check(phone.speaks.includes('ECHO boot: first phone turn'), 'a phone turn spawned the agent', JSON.stringify(phone.speaks));
  check(phone.speaks.includes('ECHO phone: phone follow up'), 'a follow-up reached the running agent as source=phone');
  await new Promise((r) => setTimeout(r, 300));
  const phoneTranscript = av.readNewest('transcripts');
  check(
    phoneTranscript.includes('EVENT: phone connected') &&
      phoneTranscript.includes('USER (phone): first phone turn') &&
      phoneTranscript.includes('USER (phone): phone follow up'),
    'phone turns are transcribed with their source',
  );

  // ── agentvoice logs ─────────────────────────────────────────────────────
  const plain = await av.run(['logs', '-n', '20']);
  check(
    plain.code === 0 && /INFO /.test(plain.stdout) && plain.stderr.includes('session log'),
    'agentvoice logs falls back to the session log without a service unit',
    plain.stdout.slice(0, 300) + plain.stderr,
  );
  const list = await av.run(['logs', '--list']);
  check(list.code === 0 && list.stdout.includes('Bridge logs') && list.stdout.includes('.log.gz'), 'agentvoice logs --list lists files', list.stdout);
  const gzName = transcripts2.find((n) => n.endsWith('.gz'));
  const cat = await av.run(['logs', '--transcripts', '--cat', gzName ?? 'missing']);
  check(cat.code === 0 && cat.stdout.includes(`USER (stream): ${CANNED[0]}`), 'agentvoice logs --cat reads a .gz back');

  // ── the in-app log viewer falls back to the session file (no journald unit here) ─
  const viewer = JSON.parse((await av.api('/api/admin/serve/logs?lines=20')).text);
  check(viewer.ok === true && viewer.unit.startsWith('file:') && viewer.text.includes('INFO'), 'Serve → logs shows the session file', JSON.stringify(viewer).slice(0, 300));

  // ── refusals ──────────────────────────────────────────────────────────
  const badToken = await av.run(['pipe', '--token', 'x'.repeat(40), '--no-listen'], { input: Buffer.alloc(3200), timeoutMs: 20_000 });
  check(badToken.code === 4, 'a wrong token is refused', `exit ${badToken.code}: ${badToken.stderr}`);
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — audio pipe, transcripts and session logs work end to end' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
