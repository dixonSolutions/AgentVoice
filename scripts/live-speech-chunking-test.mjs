#!/usr/bin/env node
/**
 * End-to-end: audio moves in the chunks it is produced in, both directions.
 *
 * A real bridge (`squeaky run`) with the real self-hosted providers —
 * local_speech for the voice, local_whisper for transcription — pointed at the
 * harness's stand-in speech server, which writes its WAV the way speaches does:
 * header first, then a piece of audio every TTS_CHUNK_DELAY_MS.
 *
 * Text to speech (POST /api/intelligence/tts, stream: true):
 *   - the reply is audio/pcm at the voice's real rate, read from its WAV header
 *   - the first audio reaches this client before the voice has produced the
 *     second piece — playback could start while the rest is synthesized
 *   - every piece arrives as its own chunk, spaced like the voice sent them
 *   - the PCM is exactly what the voice produced, header stripped
 *   - hanging up mid-line stops the voice's request on the bridge (barge-in)
 *   - without `stream`, the same voice still answers one whole file
 *
 * Speech to text (/ws/stt):
 *   - each mic chunk is on the bridge while the speaker is still talking
 *   - `end` → transcript in a few milliseconds plus the engine's time: the
 *     engine gets the whole utterance at once, with nothing left to upload
 *   - a cancelled utterance never reaches the engine
 *   - the POST fallback still transcribes the same audio
 *
 * Usage:
 *   npm run build:backend && node scripts/live-speech-chunking-test.mjs [--bin squeaky] [--keep]
 */

import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createInstance, makeReporter, ROOT, TTS_PIECES, TTS_PIECE_MS, TTS_RATE, ttsPcm } from './e2e-harness.mjs';

const args = process.argv.slice(2);
const binFlag = args.indexOf('--bin');
const BIN = binFlag !== -1 ? [args[binFlag + 1]] : [process.execPath, join(ROOT, 'dist', 'cli.js')];
const KEEP = args.includes('--keep');
const TTS_CHUNK_DELAY_MS = 300;
const CANNED = ['open the readme please', 'this one is cancelled', 'and the fallback'];

const report = makeReporter();
const { say, check, fail } = report;
const now = () => performance.timeOrigin + performance.now();

const av = await createInstance({
  bin: BIN,
  canned: CANNED,
  ttsChunkDelayMs: TTS_CHUNK_DELAY_MS,
  configure(config) {
    const audio = config.settings.workflow.llmIntelligence.audio;
    audio.tts = { provider: 'local_speech', fallbacks: [], language: 'auto', models: {}, voices: {}, scopes: {} };
  },
});

async function ttsRequest(body, { abortAfterFirstChunk = false } = {}) {
  const abort = new AbortController();
  const startedAt = now();
  const res = await fetch(`${av.base}/api/intelligence/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${av.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  const chunks = [];
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: now() - startedAt, bytes: Buffer.from(value) });
      if (abortAfterFirstChunk) {
        abort.abort();
        break;
      }
    }
  } catch (err) {
    if (!abortAfterFirstChunk) throw err;
  }
  return { res, chunks, startedAt };
}

/** Open /ws/stt and authenticate. */
async function sttSocket() {
  const ws = new WebSocket(`${av.base.replace(/^http/, 'ws')}/ws/stt`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    msg.at = now();
    inbox.push(msg);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = async (type, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type || m.type === 'error');
      if (i !== -1) return inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no ${type} from /ws/stt`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  ws.send(JSON.stringify({ type: 'auth', token: av.token }));
  const ok = await next('auth_ok');
  return { ws, ok, next };
}

/** 16 kHz mono PCM: a tone of `ms`. */
function micPcm(ms) {
  const n = Math.round(16 * ms);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 9000), i * 2);
  return buf;
}

try {
  say(`scratch: ${av.tmp}`);
  await av.startBridge();
  say('bridge up');

  // ── Text to speech ────────────────────────────────────────────────────
  const voice = Buffer.concat(ttsPcm(TTS_RATE, TTS_PIECES, TTS_PIECE_MS));
  const streamed = await ttsRequest({ text: 'Streaming check, one two three.', stream: true });
  const ttsReq = av.ttsRequests.at(-1);
  const pcmOut = Buffer.concat(streamed.chunks.map((c) => c.bytes));
  const firstAt = streamed.chunks[0]?.at ?? Infinity;
  const lastAt = streamed.chunks.at(-1)?.at ?? 0;
  say(
    `tts: ${streamed.res.headers.get('content-type')} · ${streamed.chunks.length} chunks · first at ${firstAt.toFixed(0)} ms, ` +
      `last at ${lastAt.toFixed(0)} ms (the voice spent ${(TTS_PIECES - 1) * TTS_CHUNK_DELAY_MS} ms producing it)`,
  );
  check(streamed.res.status === 200, 'streamed reply is 200', String(streamed.res.status));
  check(
    /^audio\/pcm;rate=24000/.test(streamed.res.headers.get('content-type') ?? '') &&
      streamed.res.headers.get('x-audio-sample-rate') === String(TTS_RATE),
    'reply is PCM at the voice’s own rate, read from its WAV header',
    streamed.res.headers.get('content-type'),
  );
  check(streamed.res.headers.get('x-speech-provider') === 'local_speech', 'X-Speech-Provider names the voice');
  check(ttsReq?.format === 'wav', 'the bridge asked the self-hosted voice for a streamable WAV', ttsReq?.format);
  check(firstAt < TTS_CHUNK_DELAY_MS, `first audio arrived before the voice produced its second piece (${firstAt.toFixed(0)} ms)`);
  check(streamed.chunks.length >= TTS_PIECES, `each piece arrived as its own chunk (${streamed.chunks.length})`);
  check(
    lastAt - firstAt >= (TTS_PIECES - 1) * TTS_CHUNK_DELAY_MS * 0.8,
    'chunks were forwarded as the voice produced them, not collected first',
    `${(lastAt - firstAt).toFixed(0)} ms spread`,
  );
  check(pcmOut.equals(voice), 'PCM is exactly what the voice produced, header stripped', `${pcmOut.length} vs ${voice.length} bytes`);

  const cut = await ttsRequest({ text: 'Barge in on this one.', stream: true }, { abortAfterFirstChunk: true });
  const cutReq = av.ttsRequests.at(-1);
  const deadline = Date.now() + 3000;
  while (!cutReq.closedEarly && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  check(cut.chunks.length === 1 && cutReq.closedEarly, 'hanging up mid-line stopped the voice’s request', `closedEarly=${cutReq.closedEarly}`);
  check(cutReq.sent.length < TTS_PIECES, 'the voice was not left synthesizing the rest', `${cutReq.sent.length}/${TTS_PIECES} pieces sent`);

  const whole = await ttsRequest({ text: 'No streaming here.' });
  check(
    whole.res.headers.get('content-type') === 'audio/mpeg' && Buffer.concat(whole.chunks.map((c) => c.bytes)).subarray(0, 3).toString() === 'ID3',
    'without stream the same voice still answers one whole file',
    whole.res.headers.get('content-type'),
  );

  // ── Speech to text over /ws/stt ───────────────────────────────────────
  const stt = await sttSocket();
  check(stt.ok.type === 'auth_ok' && stt.ok.live === false, '/ws/stt: whole-utterance engine announced as not live', JSON.stringify(stt.ok));

  const utterance = micPcm(1500);
  const CHUNK = 640; // 20 ms
  stt.ws.send(JSON.stringify({ type: 'begin', id: 'u1', sampleRate: 16_000, encoding: 'pcm_s16le', channels: 1 }));
  const sttBefore = av.sttRequests.length;
  for (let off = 0; off < utterance.length; off += CHUNK) {
    stt.ws.send(utterance.subarray(off, off + CHUNK));
    await new Promise((r) => setTimeout(r, 20));
  }
  check(av.sttRequests.length === sttBefore, 'a whole-utterance engine is not called while the speaker talks');
  const endAt = now();
  stt.ws.send(JSON.stringify({ type: 'end', id: 'u1' }));
  const t1 = await stt.next('transcript');
  const engine = av.sttRequests.at(-1);
  const afterEnd = t1.at - endAt;
  say(`stt: transcript ${afterEnd.toFixed(1)} ms after end (engine request ${engine.bytes} bytes)`);
  check(t1.type === 'transcript' && t1.text === CANNED[0] && t1.id === 'u1', 'transcript comes back on the socket', JSON.stringify(t1));
  check(engine.bytes > utterance.length && engine.bytes < utterance.length + 2048, 'the engine got the whole utterance as one WAV (multipart)', `${engine.bytes} bytes for ${utterance.length} PCM`);
  check(engine.startedAt - endAt < 50, `the engine was called the moment the utterance ended (${(engine.startedAt - endAt).toFixed(1)} ms)`);
  check(afterEnd < 150, `transcript ${afterEnd.toFixed(1)} ms after the end of speech`);

  stt.ws.send(JSON.stringify({ type: 'begin', id: 'u2' }));
  stt.ws.send(micPcm(500));
  stt.ws.send(JSON.stringify({ type: 'cancel', id: 'u2' }));
  stt.ws.send(JSON.stringify({ type: 'ping' }));
  await stt.next('pong');
  check(av.sttRequests.length === sttBefore + 1, 'a cancelled utterance never reaches the engine');
  stt.ws.close();

  const posted = await fetch(`${av.base}/api/intelligence/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${av.token}`, 'content-type': 'application/octet-stream' },
    body: micPcm(800),
  });
  const postedBody = await posted.json();
  check(posted.status === 200 && postedBody.text === CANNED[1], 'the POST fallback still transcribes', JSON.stringify(postedBody));

  const bridgeLog = av.readNewest('bridge');
  check(/tts streamed/.test(bridgeLog) && /stt upload transcribed/.test(bridgeLog), 'bridge logged both directions');
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — speech audio moves in the chunks it is produced in' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
