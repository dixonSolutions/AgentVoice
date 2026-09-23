import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { PcmSegmenter, frameRms, type AudioSegment, type SegmenterOptions } from './segmenter.js';
import { jaggedChunks, RATE, silence, tone } from './testAudio.js';

const OPTS: SegmenterOptions = {
  sampleRate: RATE,
  segmentSilenceMs: 700,
  maxSegmentMs: 15_000,
  minSpeechMs: 300,
  speechThreshold: 0.012,
  preRollMs: 300,
};

function run(audio: Buffer, opts: Partial<SegmenterOptions> = {}, chunks?: Buffer[]): AudioSegment[] {
  const seg = new PcmSegmenter({ ...OPTS, ...opts });
  const out: AudioSegment[] = [];
  for (const chunk of chunks ?? [audio]) out.push(...seg.push(chunk));
  const tail = seg.flush();
  if (tail) out.push(tail);
  return out;
}

describe('frameRms', () => {
  it('is 0 for silence and ~amplitude/√2 for a sine', () => {
    assert.equal(frameRms(silence(20)), 0);
    const rms = frameRms(tone(20, 0.5));
    assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.02, `rms ${rms}`);
  });
});

describe('PcmSegmenter', () => {
  it('cuts one segment per phrase, at the pause', () => {
    const audio = Buffer.concat([silence(500), tone(1200), silence(900), tone(800), silence(900)]);
    const segs = run(audio);
    assert.equal(segs.length, 2);
    assert.deepEqual(
      segs.map((s) => s.reason),
      ['pause', 'pause'],
    );
    assert.equal(segs[0]!.speechMs, 1200);
    assert.equal(segs[1]!.speechMs, 800);
  });

  it('keeps pre-roll before speech and trims long trailing silence', () => {
    const [seg] = run(Buffer.concat([silence(1000), tone(1000), silence(1000)]));
    assert.ok(seg);
    // 300 ms pre-roll + 1000 ms speech + 200 ms kept of the trailing pause.
    assert.equal(seg.startMs, 700);
    assert.equal(seg.durationMs, 1500);
    assert.equal(seg.pcm.length, (RATE * 1.5) * 2);
  });

  it('drops blips shorter than minSpeechMs', () => {
    const segs = run(Buffer.concat([silence(300), tone(100), silence(1000), tone(60), silence(1000)]));
    assert.equal(segs.length, 0);
  });

  it('does not split on pauses shorter than segmentSilenceMs', () => {
    const audio = Buffer.concat([tone(600), silence(400), tone(600), silence(400), tone(600), silence(1000)]);
    const segs = run(audio);
    assert.equal(segs.length, 1);
    assert.equal(segs[0]!.speechMs, 1800);
  });

  it('caps continuous speech at maxSegmentMs and carries on', () => {
    const segs = run(Buffer.concat([tone(5000), silence(1000)]), { maxSegmentMs: 2000 });
    assert.deepEqual(
      segs.map((s) => s.reason),
      ['max_length', 'max_length', 'pause'],
    );
    assert.equal(segs.reduce((n, s) => n + s.speechMs, 0), 5000);
  });

  it('flush() ends the segment in progress', () => {
    const seg = new PcmSegmenter(OPTS);
    assert.deepEqual(seg.push(tone(800)), []);
    assert.equal(seg.inSegment, true);
    const flushed = seg.flush();
    assert.equal(flushed?.reason, 'flush');
    assert.equal(seg.inSegment, false);
    assert.equal(seg.flush(), null);
  });

  it('segments identically however the stream is chunked', () => {
    const audio = Buffer.concat([silence(250), tone(900), silence(800), tone(700), silence(750), tone(1300)]);
    const whole = run(audio);
    const jagged = run(audio, {}, jaggedChunks(audio));
    assert.equal(jagged.length, whole.length);
    for (let i = 0; i < whole.length; i++) {
      assert.equal(jagged[i]!.startMs, whole[i]!.startMs);
      assert.ok(jagged[i]!.pcm.equals(whole[i]!.pcm));
    }
  });

  it('respects the speech threshold', () => {
    const quiet = Buffer.concat([tone(1000, 0.01), silence(1000)]);
    assert.equal(run(quiet).length, 0);
    assert.equal(run(quiet, { speechThreshold: 0.005 }).length, 1);
  });

  it('tracks how much audio it has received', () => {
    const seg = new PcmSegmenter(OPTS);
    seg.push(silence(1000));
    assert.equal(seg.receivedMs, 1000);
  });
});
