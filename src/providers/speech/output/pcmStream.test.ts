import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  bodyChunks,
  downmixPcm16,
  parseWavHeader,
  rawPcmStream,
  sseData,
  wavPcmStream,
} from './pcmStream.js';

/** An async source whose chunks are released one at a time by the test. */
function gatedSource() {
  const queue: (Buffer | null)[] = [];
  let wake: (() => void) | null = null;
  let pulled = 0;
  const source: AsyncIterable<Buffer> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((r) => (wake = r));
        const next = queue.shift()!;
        if (next === null) return;
        pulled += 1;
        yield next;
      }
    },
  };
  return {
    source,
    release(chunk: Buffer | null) {
      queue.push(chunk);
      wake?.();
      wake = null;
    },
    get pulled() {
      return pulled;
    },
  };
}

function wavHeader(opts: { rate: number; channels?: number; bits?: number; list?: boolean; streaming?: boolean }): Buffer {
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(opts.rate, 12);
  fmt.writeUInt32LE((opts.rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const parts = [Buffer.from('RIFF'), Buffer.alloc(4, 0xff), Buffer.from('WAVE'), fmt];
  if (opts.list) {
    const list = Buffer.alloc(8 + 26);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(26, 4);
    list.write('INFOISFT\u000e\u0000\u0000\u0000Lavf61.7.100\u0000\u0000', 8, 'latin1');
    parts.push(list);
  }
  const data = Buffer.alloc(8);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(opts.streaming === false ? 0 : 0xffffffff, 4);
  parts.push(data);
  return Buffer.concat(parts);
}

const pcm = (...samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('parseWavHeader', () => {
  it('finds the audio after an ffmpeg LIST chunk, ignoring streaming size fields', () => {
    const head = wavHeader({ rate: 22_050, list: true });
    const parsed = parseWavHeader(head);
    assert.deepEqual(parsed?.format, { sampleRate: 22_050, channels: 1, bitsPerSample: 16 });
    assert.equal(parsed?.dataOffset, head.length);
  });

  it('asks for more bytes until the data chunk is in', () => {
    const head = wavHeader({ rate: 24_000 });
    for (let n = 0; n < head.length; n++) assert.equal(parseWavHeader(head.subarray(0, n)), null, `at ${n} bytes`);
  });

  it('refuses what it cannot stream', () => {
    assert.throws(() => parseWavHeader(wavHeader({ rate: 24_000, bits: 8 })), /16-bit PCM only/);
    assert.throws(() => parseWavHeader(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000')), /did not return a WAV/);
  });
});

describe('wavPcmStream', () => {
  it('hands on each chunk as it arrives, header stripped', async () => {
    const gate = gatedSource();
    const head = wavHeader({ rate: 24_000 });
    // Header split across two network chunks, first audio riding on the second.
    gate.release(head.subarray(0, 10));
    gate.release(Buffer.concat([head.subarray(10), pcm(1, 2)]));
    const stream = await wavPcmStream(gate.source);
    assert.equal(stream.sampleRate, 24_000);

    const it = stream.chunks[Symbol.asyncIterator]();
    assert.deepEqual((await it.next()).value, pcm(1, 2));
    // The vendor has sent nothing else yet — the first audio is already out.
    gate.release(pcm(3));
    assert.deepEqual((await it.next()).value, pcm(3));
    gate.release(null);
    assert.equal((await it.next()).done, true);
  });

  it('downmixes stereo to mono across chunk boundaries', async () => {
    const out = await collect(downmixPcm16((async function* () {
      yield pcm(100, 300, 50).subarray(0, 5); // a frame and a half (split mid-sample)
      yield Buffer.concat([pcm(100, 300, 50).subarray(5), pcm(-50)]);
    })(), 2));
    assert.deepEqual(Buffer.concat(out), pcm(200, 0));
  });
});

describe('rawPcmStream', () => {
  it('fails inside the chain when the vendor sends nothing', async () => {
    await assert.rejects(rawPcmStream((async function* () {})(), 24_000), /returned no audio/);
  });
});

describe('sseData', () => {
  it('reassembles events split anywhere', async () => {
    const wire = 'data: {"a":1}\n\n: comment\n\ndata: {"b":\ndata: 2}\r\n\r\ndata: last';
    const chunks = [...wire].map((c) => Buffer.from(c));
    const events = [];
    for await (const e of sseData((async function* () { yield* chunks; })())) events.push(e);
    assert.deepEqual(events, ['{"a":1}', '{"b":\n2}', 'last']);
  });
});

describe('bodyChunks', () => {
  it('yields a fetch body chunk by chunk and stops the upstream on abort', async () => {
    let cancelled = false;
    let push!: (b: Uint8Array) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (b) => controller.enqueue(b);
      },
      cancel() {
        cancelled = true;
      },
    });
    const abort = new AbortController();
    const it = bodyChunks(new Response(body), { signal: abort.signal })[Symbol.asyncIterator]();
    push(new Uint8Array([1, 2]));
    assert.deepEqual((await it.next()).value, Buffer.from([1, 2]));
    const pending = it.next();
    abort.abort();
    assert.equal((await pending).done, true);
    assert.equal(cancelled, true);
  });

  it('gives up on a body that goes quiet', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    await assert.rejects(collect(bodyChunks(new Response(body), { idleMs: 30 })), /No audio for/);
  });
});
