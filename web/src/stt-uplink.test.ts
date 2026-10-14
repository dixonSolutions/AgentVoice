import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SttUplink, SttUplinkUnavailable, type UplinkSocket } from './stt-uplink.js';

type Frame = { at: number; json?: Record<string, unknown>; bytes?: number };

/** A stand-in /ws/stt: records what arrives and when, answers `end` with `reply`. */
async function fakeBridge(reply: (id: string, bytes: number) => Record<string, unknown> | null) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const frames: Frame[] = [];
  const sockets: WebSocket[] = [];
  let bytes = 0;
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const at = Date.now();
      if (isBinary) {
        const n = (raw as Buffer).length;
        bytes += n;
        frames.push({ at, bytes: n });
        return;
      }
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push({ at, json: msg });
      if (msg['type'] === 'auth') ws.send(JSON.stringify({ type: 'auth_ok', live: true }));
      if (msg['type'] === 'begin') bytes = 0;
      if (msg['type'] === 'end') {
        const r = reply(String(msg['id']), bytes);
        if (r) ws.send(JSON.stringify({ id: msg['id'], ...r }));
      }
    });
  });
  const base = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return {
    base,
    frames,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => r());
      }),
  };
}

const factory = (url: string) => new WebSocket(url) as unknown as UplinkSocket;
const chunk = (n: number) => new Int16Array(n).fill(7);
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('SttUplink', () => {
  it('sends each chunk the moment it is captured, then gets the transcript', async () => {
    const bridge = await fakeBridge((_id, bytes) => ({ type: 'transcript', text: `heard ${bytes} bytes`, provider: 'amazon_transcribe', live: true }));
    cleanups.push(bridge.close);
    const up = new SttUplink(bridge.base, 'tok', factory);
    cleanups.push(() => up.close());
    up.connect();
    await until(() => up.isReady);
    assert.equal(up.live, true);

    up.begin();
    up.send(chunk(160));
    // The chunk is on the bridge while the speaker is still talking.
    await until(() => bridge.frames.some((f) => f.bytes === 320));
    up.send(chunk(160));
    await until(() => bridge.frames.filter((f) => f.bytes).length === 2);

    const result = await up.finish();
    assert.deepEqual(result, { text: 'heard 640 bytes', provider: 'amazon_transcribe', live: true });
    const types = bridge.frames.map((f) => f.json?.['type'] ?? 'audio');
    assert.deepEqual(types, ['auth', 'begin', 'audio', 'audio', 'end']);
  });

  it('replays the utterance from the start after reconnecting mid-sentence', async () => {
    const bridge = await fakeBridge((_id, bytes) => ({ type: 'transcript', text: String(bytes) }));
    cleanups.push(bridge.close);
    const up = new SttUplink(bridge.base, 'tok', factory);
    cleanups.push(() => up.close());
    up.connect();
    await until(() => up.isReady);
    up.begin();
    up.send(chunk(100));
    await until(() => bridge.frames.some((f) => f.bytes));
    bridge.sockets[0]!.terminate();
    await until(() => !up.isReady);
    up.send(chunk(100)); // captured while disconnected
    up.connect();
    await until(() => up.isReady);
    const result = await up.finish();
    assert.equal(result.text, '400', 'both chunks, sent again on the new socket');
  });

  it('reports itself unavailable so the caller can POST, but not on an engine error', async () => {
    const offline = new SttUplink('http://127.0.0.1:1', 'tok', factory);
    offline.connect();
    offline.begin();
    offline.send(chunk(10));
    await assert.rejects(offline.finish(), SttUplinkUnavailable);
    offline.close();

    const bridge = await fakeBridge(() => ({ type: 'error', message: 'No speech detected', code: 'EMPTY' }));
    cleanups.push(bridge.close);
    const up = new SttUplink(bridge.base, 'tok', factory);
    cleanups.push(() => up.close());
    up.connect();
    await until(() => up.isReady);
    up.begin();
    up.send(chunk(10));
    await assert.rejects(up.finish(), (err: Error) => !(err instanceof SttUplinkUnavailable) && /No speech detected/.test(err.message));
  });

  it('a connection lost while waiting falls back, and cancel abandons a pending transcript', async () => {
    const bridge = await fakeBridge(() => null);
    cleanups.push(bridge.close);
    const up = new SttUplink(bridge.base, 'tok', factory);
    cleanups.push(() => up.close());
    up.connect();
    await until(() => up.isReady);
    up.begin();
    up.send(chunk(10));
    const waiting = up.finish();
    await until(() => bridge.frames.some((f) => f.json?.['type'] === 'end'));
    bridge.sockets[0]!.terminate();
    await assert.rejects(waiting, SttUplinkUnavailable);

    up.connect();
    await until(() => up.isReady);
    up.begin();
    up.send(chunk(10));
    const abandoned = up.finish();
    up.cancel();
    await assert.rejects(abandoned, (err: Error) => err.name === 'AbortError');
    await until(() => bridge.frames.some((f) => f.json?.['type'] === 'cancel'));
  });
});
