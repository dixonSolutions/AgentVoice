import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { PipeTranscript } from './pipe.js';
import { relayStreamTranscript, type StreamDeliveryOutcome } from './relay.js';

const T: PipeTranscript = {
  index: 3,
  text: 'open the readme',
  provider: 'fake',
  audioMs: 1200,
  speechMs: 900,
  latencyMs: 240,
  merged: 1,
  reason: 'pause',
};

describe('relayStreamTranscript', () => {
  it('sends the text before the agent is spawned or queued', () => {
    const log: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const outcome = relayStreamTranscript(
      T,
      (f) => {
        frames.push(f);
        log.push(`send ${String(f['type'])}`);
      },
      (text) => {
        log.push(`deliver ${text}`);
        return { ok: true, delivery: 'spawn' } as const;
      },
    );
    assert.deepEqual(log, ['send transcript', 'deliver open the readme', 'send segment']);
    assert.deepEqual(outcome, { ok: true, delivery: 'spawn' });
    assert.deepEqual(frames[0], {
      type: 'transcript',
      index: 3,
      text: 'open the readme',
      audio_ms: 1200,
      latency_ms: 240,
      provider: 'fake',
      merged: 1,
    });
    assert.deepEqual(frames[1], { ...frames[0], type: 'segment', delivered: true, delivery: 'spawn' });
  });

  it('still shows the words when delivery fails, then says why', () => {
    const frames: Record<string, unknown>[] = [];
    relayStreamTranscript({ ...T, provider: undefined }, (f) => frames.push(f), () => ({
      ok: false,
      reason: 'NO_PROJECT',
      message: 'No project is selected.',
    }));
    assert.equal(frames[0]!['type'], 'transcript');
    assert.equal(frames[0]!['text'], 'open the readme');
    assert.equal(frames[0]!['provider'], null);
    assert.equal(frames[1]!['delivered'], false);
    assert.equal(frames[1]!['reason'], 'NO_PROJECT');
    assert.equal(frames[1]!['message'], 'No project is selected.');
    assert.equal('delivery' in frames[1]!, false);
  });

  it('puts the transcript on the wire before delivery blocks the event loop', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const serverSide = once(wss, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    await once(client, 'open');
    const [server] = (await serverSide) as [WebSocket];
    const received: { type: string; at: number }[] = [];
    client.on('message', (raw) => {
      received.push({ type: (JSON.parse(raw.toString()) as { type: string }).type, at: Date.now() });
    });

    let unsentWhenDeliveryStarted = -1;
    let deliveryEndedAt = 0;
    relayStreamTranscript(
      T,
      (f) => server.send(JSON.stringify(f)),
      (): StreamDeliveryOutcome => {
        // Nothing of the transcript frame may still be waiting in the bridge…
        unsentWhenDeliveryStarted = server.bufferedAmount;
        // …while delivery hogs the loop the way a spawn + sync writes do.
        const until = Date.now() + 150;
        while (Date.now() < until) {
          // busy
        }
        deliveryEndedAt = Date.now();
        return { ok: true, delivery: 'queued' };
      },
    );

    while (received.length < 2) await once(client, 'message');
    assert.equal(unsentWhenDeliveryStarted, 0, 'transcript frame left the process before delivery');
    assert.deepEqual(
      received.map((r) => r.type),
      ['transcript', 'segment'],
    );
    assert.ok(deliveryEndedAt > 0);

    client.close();
    await once(client, 'close');
    wss.close();
  });
});
