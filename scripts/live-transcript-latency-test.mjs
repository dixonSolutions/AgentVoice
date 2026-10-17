#!/usr/bin/env node
/**
 * End-to-end latency of the transcript hop: speech engine answers → the web
 * client has the text.
 *
 * A real bridge (`squeaky run`, serve profile) with the real local_whisper
 * provider pointed at the harness's stand-in Whisper, and the stub agent as
 * "Claude Code". This script then plays the PWA on /ws/audio-stream
 * (`client: "pwa"`, `listen: false`) and streams three phrases in real time.
 *
 * For every segment it measures
 *
 *   bridge hop = first frame carrying the text arrives here
 *                − the stand-in Whisper finished answering that request
 *
 * Both clocks are this process's, so the number is everything the bridge does
 * between the engine's reply and the web client seeing the words: parsing the
 * provider response, the pipe, and — before this was fixed — spawning or
 * queueing the agent, the turn-history insert and the transcript write, all of
 * which ran before the text was sent.
 *
 * Asserts:
 *   - every segment's text reaches the client within HOP_BUDGET_MS of the
 *     engine's reply, including the first one, which spawns the agent
 *   - the `transcript` frame arrives before that segment's `segment` (delivery)
 *     frame, and carries the same text
 *   - delivery still happens: spawn first, then the running agent
 *
 * Usage:
 *   npm run build:backend && node scripts/live-transcript-latency-test.mjs [--bin squeaky] [--keep]
 */

import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createInstance, makeReporter, ROOT } from './e2e-harness.mjs';

const args = process.argv.slice(2);
const binFlag = args.indexOf('--bin');
const BIN = binFlag !== -1 ? [args[binFlag + 1]] : [process.execPath, join(ROOT, 'dist', 'cli.js')];
const KEEP = args.includes('--keep');
const CANNED = ['open the readme', 'and summarise it', 'then list the tests'];

/**
 * Generous for CI runners: the hop itself is a loopback HTTP reply plus one
 * WebSocket frame — single-digit milliseconds on a laptop. What it must never
 * include again is the agent spawn and the bookkeeping behind it.
 */
const HOP_BUDGET_MS = Number(process.env.HOP_BUDGET_MS ?? 40);

const RATE = 16_000;
const CHUNK_MS = 40;

/** PCM16LE mono 16 kHz: [kind, ms] steps, "tone" loud enough to count as speech. */
function pcm(plan) {
  const parts = plan.map(([kind, ms]) => {
    const n = Math.round((RATE * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    if (kind === 'tone') {
      for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 9000), i * 2);
    }
    return buf;
  });
  return Buffer.concat(parts);
}

/** Stream `audio` as the PWA does, in real time; resolve with every frame and when it landed. */
function streamLikeThePwa(base, token, audio, timeoutMs = 60_000) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/audio-stream`);
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`stream did not drain in ${timeoutMs} ms; frames: ${JSON.stringify(frames.map((f) => f.msg.type))}`));
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const at = performance.timeOrigin + performance.now();
      const msg = JSON.parse(raw.toString());
      frames.push({ at, msg });
      if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'start', sampleRate: RATE, encoding: 'pcm_s16le', channels: 1, client: 'pwa', listen: false }));
      } else if (msg.type === 'ready') {
        const bytesPerChunk = (RATE * 2 * CHUNK_MS) / 1000;
        let offset = 0;
        const tick = setInterval(() => {
          if (offset >= audio.length) {
            clearInterval(tick);
            ws.send(JSON.stringify({ type: 'end' }));
            return;
          }
          ws.send(audio.subarray(offset, offset + bytesPerChunk));
          offset += bytesPerChunk;
        }, CHUNK_MS);
      } else if (msg.type === 'drained') {
        clearTimeout(timer);
        ws.close();
        resolve(frames);
      } else if (msg.type === 'error' && msg.fatal) {
        clearTimeout(timer);
        reject(new Error(`stream refused: ${msg.message}`));
      }
    });
  });
}

const report = makeReporter();
const { say, check, fail } = report;
const av = await createInstance({ bin: BIN, canned: CANNED });

// Timestamp the stand-in's replies precisely: `at` in the harness is taken
// just before it answers, with millisecond resolution.
const engineDoneAt = [];
const origPush = av.sttRequests.push.bind(av.sttRequests);
av.sttRequests.push = (...items) => {
  for (let i = 0; i < items.length; i++) engineDoneAt.push(performance.timeOrigin + performance.now());
  return origPush(...items);
};

try {
  say(`scratch: ${av.tmp}`);
  await av.startBridge();
  say('bridge up');
  check((await av.api('/api/active-project', { project: 'e2e' })).status === 200, 'selected the project');
  const prep = await av.api('/api/voice-session/prepare', { project: 'e2e' });
  check(/"ok":true/.test(prep.text), 'MCP registration prepared', prep.text.slice(-300));

  const audio = pcm([
    ['silence', 300],
    ['tone', 900],
    ['silence', 1200],
    ['tone', 900],
    ['silence', 1200],
    ['tone', 900],
    ['silence', 1200],
  ]);
  const frames = await streamLikeThePwa(av.base, av.token, audio);

  const firstTextAt = new Map();
  const transcriptFrame = new Map();
  const segmentFrame = new Map();
  for (const { at, msg } of frames) {
    if (msg.type !== 'transcript' && msg.type !== 'segment') continue;
    if (!firstTextAt.has(msg.index)) firstTextAt.set(msg.index, at);
    (msg.type === 'transcript' ? transcriptFrame : segmentFrame).set(msg.index, { at, msg });
  }

  check(segmentFrame.size === CANNED.length, `${CANNED.length} phrases → ${CANNED.length} segments`, `got ${segmentFrame.size}`);
  check(av.sttRequests.length === CANNED.length, 'speech engine called once per segment', `calls ${av.sttRequests.length}`);

  const rows = [];
  for (let index = 1; index <= CANNED.length; index++) {
    const engine = engineDoneAt[index - 1];
    const text = firstTextAt.get(index);
    const seg = segmentFrame.get(index);
    const tr = transcriptFrame.get(index);
    const hop = engine !== undefined && text !== undefined ? text - engine : NaN;
    const deliveredAfter = seg && engine !== undefined ? seg.at - engine : NaN;
    rows.push({ index, hop, deliveredAfter, delivery: seg?.msg.delivery ?? '—' });

    check(
      Number.isFinite(hop) && hop <= HOP_BUDGET_MS,
      `segment ${index}: text reached the web client ${hop.toFixed(1)} ms after the engine answered (budget ${HOP_BUDGET_MS} ms)`,
    );
    check(tr !== undefined, `segment ${index}: sent as a transcript frame`);
    check(tr?.msg.text === CANNED[index - 1] && seg?.msg.text === CANNED[index - 1], `segment ${index}: same text in transcript and segment`, `${tr?.msg.text} / ${seg?.msg.text}`);
    check(tr !== undefined && seg !== undefined && tr.at <= seg.at, `segment ${index}: transcript frame before the delivery frame`);
  }

  check(segmentFrame.get(1)?.msg.delivery === 'spawn', 'first segment spawned the agent', segmentFrame.get(1)?.msg.delivery);
  check(
    [2, 3].every((i) => ['queued', 'waiter', 'tool_interrupt'].includes(segmentFrame.get(i)?.msg.delivery)),
    'later segments went to the running agent',
    [2, 3].map((i) => segmentFrame.get(i)?.msg.delivery).join(','),
  );

  say('segment │ engine → web text │ engine → delivery frame │ delivery');
  for (const r of rows) {
    say(`   ${r.index}    │ ${r.hop.toFixed(1).padStart(10)} ms   │ ${r.deliveredAfter.toFixed(1).padStart(15)} ms      │ ${r.delivery}`);
  }
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — transcripts reach the web client as soon as they are transcribed' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
