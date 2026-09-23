import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AudioStreamPipe, type PipeTranscript, type TranscribeFn } from './pipe.js';
import { RATE, silence, tone } from './testAudio.js';

const SEGMENTER = {
  sampleRate: RATE,
  segmentSilenceMs: 500,
  maxSegmentMs: 15_000,
  minSpeechMs: 200,
  speechThreshold: 0.012,
  preRollMs: 100,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transcriber that names each request by its audio length, with a set latency per call. */
function fakeTranscriber(latencies: number[] = []): { fn: TranscribeFn; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const fn: TranscribeFn = async (pcm) => {
    const ms = Math.round((pcm.length / 2 / RATE) * 1000);
    calls.push(ms);
    await sleep(latencies[i++] ?? 1);
    return { text: `clip ${calls.length}`, provider: 'fake' };
  };
  return { fn, calls };
}

describe('AudioStreamPipe', () => {
  it('transcribes segments in speaking order even when latency varies', async () => {
    const { fn } = fakeTranscriber([60, 5, 30]);
    const got: PipeTranscript[] = [];
    const pipe = new AudioStreamPipe({ segmenter: SEGMENTER, transcribe: fn, onTranscript: (t) => got.push(t), maxBacklog: 10 });
    pipe.push(Buffer.concat([tone(400), silence(600), tone(400), silence(600), tone(400), silence(600)]));
    await pipe.drain();
    assert.deepEqual(
      got.map((t) => t.index),
      [1, 2, 3],
    );
    assert.deepEqual(
      got.map((t) => t.text),
      ['clip 1', 'clip 2', 'clip 3'],
    );
    assert.equal(got[0]!.provider, 'fake');
  });

  it('merges waiting segments when the engine falls behind', async () => {
    const { fn, calls } = fakeTranscriber([80]);
    const got: PipeTranscript[] = [];
    const pipe = new AudioStreamPipe({ segmenter: SEGMENTER, transcribe: fn, onTranscript: (t) => got.push(t), maxBacklog: 1 });
    // Four phrases arrive at once; the first is in flight while three queue up.
    for (let i = 0; i < 4; i++) pipe.push(Buffer.concat([tone(400), silence(600)]));
    await pipe.drain();
    assert.equal(calls.length, 2, `calls: ${calls.join(',')}`);
    assert.equal(got[1]!.merged, 3);
    assert.equal(pipe.getStats().merged, 2);
  });

  it('reports empty transcripts and errors without stopping', async () => {
    let n = 0;
    const empty: number[] = [];
    const errors: string[] = [];
    const got: string[] = [];
    const pipe = new AudioStreamPipe({
      segmenter: SEGMENTER,
      transcribe: async () => {
        n += 1;
        if (n === 1) return { text: '   ' };
        if (n === 2) throw new Error('engine down');
        return { text: 'finally' };
      },
      onTranscript: (t) => got.push(t.text),
      onEmpty: ({ index }) => empty.push(index),
      onError: (err) => errors.push(err.message),
      maxBacklog: 10,
    });
    for (let i = 0; i < 3; i++) pipe.push(Buffer.concat([tone(400), silence(600)]));
    await pipe.drain();
    assert.deepEqual(empty, [1]);
    assert.deepEqual(errors, ['engine down']);
    assert.deepEqual(got, ['finally']);
    const stats = pipe.getStats();
    assert.equal(stats.segments, 3);
    assert.equal(stats.transcripts, 1);
    assert.equal(stats.empty, 1);
    assert.equal(stats.errors, 1);
  });

  it('drain() flushes a segment still being spoken', async () => {
    const { fn } = fakeTranscriber();
    const got: string[] = [];
    const pipe = new AudioStreamPipe({ segmenter: SEGMENTER, transcribe: fn, onTranscript: (t) => got.push(t.text) });
    pipe.push(tone(700));
    assert.equal(pipe.hearingSpeech, true);
    await pipe.drain();
    assert.deepEqual(got, ['clip 1']);
  });

  it('close() aborts the in-flight request and drops the rest', async () => {
    let aborted = false;
    const got: string[] = [];
    const pipe = new AudioStreamPipe({
      segmenter: SEGMENTER,
      transcribe: (_pcm, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ text: 'too late' });
          });
        }),
      onTranscript: (t) => got.push(t.text),
    });
    pipe.push(Buffer.concat([tone(400), silence(600)]));
    await sleep(5);
    pipe.close();
    await sleep(5);
    assert.equal(aborted, true);
    assert.deepEqual(got, []);
    pipe.push(Buffer.concat([tone(400), silence(600)]));
    assert.equal(pipe.getStats().segments, 1);
  });
});
