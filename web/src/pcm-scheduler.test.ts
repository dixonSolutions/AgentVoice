import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PcmScheduler,
  resampleLinear,
  streamedPcmRate,
  type PcmBufferLike,
  type PcmContextLike,
  type PcmSourceLike,
} from './pcm-scheduler.js';

interface FakeSource extends PcmSourceLike {
  startedAt: number | null;
  stopped: boolean;
  samples: Float32Array;
  rate: number;
}

function fakeContext(opts: { sampleRate?: number; minBufferRate?: number } = {}) {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: opts.sampleRate ?? 48_000,
    createBuffer(_channels: number, length: number, rate: number): PcmBufferLike & { rate: number } {
      if (opts.minBufferRate && rate < opts.minBufferRate) throw new Error('NotSupportedError');
      const data = new Float32Array(length);
      return { rate, getChannelData: () => data };
    },
    createBufferSource(): PcmSourceLike {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        startedAt: null,
        stopped: false,
        get samples() {
          return (this.buffer as PcmBufferLike).getChannelData(0);
        },
        get rate() {
          return (this.buffer as { rate: number }).rate;
        },
        connect: () => undefined,
        start(when: number) {
          this.startedAt = when;
        },
        stop() {
          this.stopped = true;
        },
        disconnect: () => undefined,
      };
      sources.push(source);
      return source;
    },
  };
  return { ctx: ctx as PcmContextLike & { currentTime: number }, sources };
}

const bytes = (...samples: number[]) => {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
};

describe('PcmScheduler', () => {
  it('starts on the first chunk and lines the rest up end to end', () => {
    const { ctx, sources } = fakeContext();
    let started = 0;
    const s = new PcmScheduler(ctx, {}, 1000, { leadSec: 0.05, onStart: () => started++ });
    s.push(bytes(...new Array(100).fill(0))); // 0.1 s at 1 kHz
    assert.equal(started, 1, 'audible as soon as the first chunk is in');
    assert.equal(sources[0]!.startedAt, 0.05);
    s.push(bytes(...new Array(50).fill(0)));
    assert.ok(Math.abs(sources[1]!.startedAt! - 0.15) < 1e-9, 'second chunk starts where the first ends');
    assert.equal(started, 1);
  });

  it('converts PCM16LE and carries a sample split across chunks', () => {
    const { ctx, sources } = fakeContext();
    const s = new PcmScheduler(ctx, {}, 24_000);
    const all = bytes(16384, -32768, 32767);
    s.push(all.subarray(0, 3)); // one and a half samples
    s.push(all.subarray(3));
    assert.deepEqual([...sources[0]!.samples], [0.5]);
    assert.deepEqual([...sources[1]!.samples], [-1, 32767 / 32768]);
  });

  it('re-anchors after the network falls behind instead of scheduling in the past', () => {
    const { ctx, sources } = fakeContext();
    const s = new PcmScheduler(ctx, {}, 1000, { leadSec: 0.02 });
    s.push(bytes(...new Array(100).fill(0)));
    ctx.currentTime = 1; // the first chunk finished long ago
    s.push(bytes(...new Array(100).fill(0)));
    assert.equal(sources[1]!.startedAt, 1.02);
  });

  it('finishes when the last chunk has played, and stop() cuts it short', async () => {
    const { ctx, sources } = fakeContext();
    const s = new PcmScheduler(ctx, {}, 1000);
    s.push(bytes(1, 2));
    s.push(bytes(3, 4));
    let done = false;
    const finished = s.finish().then(() => (done = true));
    sources[0]!.onended?.();
    await Promise.resolve();
    assert.equal(done, false, 'one chunk still playing');
    sources[1]!.onended?.();
    await finished;

    const b = fakeContext();
    const s2 = new PcmScheduler(b.ctx, {}, 1000);
    s2.push(bytes(1, 2));
    s2.stop();
    assert.equal(b.sources[0]!.stopped, true);
    s2.push(bytes(3)); // ignored after stop
    assert.equal(b.sources.length, 1);
    await s2.finish();
  });

  it('resamples when the context refuses the stream rate (old Safari, 16 kHz Polly)', () => {
    const { ctx, sources } = fakeContext({ sampleRate: 48_000, minBufferRate: 22_050 });
    const s = new PcmScheduler(ctx, {}, 16_000);
    s.push(bytes(...new Array(160).fill(1000)));
    assert.equal(sources[0]!.rate, 48_000);
    assert.equal(sources[0]!.samples.length, 480);
  });
});

describe('streamedPcmRate', () => {
  it('reads the rate from a streamed reply and ignores whole files', () => {
    assert.equal(streamedPcmRate('audio/pcm;rate=24000;channels=1;bits=16', null), 24_000);
    assert.equal(streamedPcmRate('audio/pcm', '16000'), 16_000);
    assert.equal(streamedPcmRate('audio/mpeg', '24000'), null);
    assert.equal(streamedPcmRate(null, null), null);
  });
});

describe('resampleLinear', () => {
  it('keeps the duration', () => {
    assert.equal(resampleLinear(new Float32Array(100), 16_000, 48_000).length, 300);
    const same = new Float32Array(3);
    assert.equal(resampleLinear(same, 8000, 8000), same);
  });
});
