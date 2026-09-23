import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AudioNormalizer, findOnPath, micRecorderCandidates, parseWavHeader, PcmConverter } from './audioInput.js';

function wav(opts: { rate: number; channels: number; bits?: number; format?: number; samples: Buffer; extraChunk?: boolean }): Buffer {
  const bits = opts.bits ?? 16;
  const format = opts.format ?? 1;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(opts.channels, 10);
  fmt.writeUInt32LE(opts.rate, 12);
  fmt.writeUInt32LE((opts.rate * opts.channels * bits) / 8, 16);
  fmt.writeUInt16LE((opts.channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = opts.extraChunk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0')]) : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(opts.samples.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + list.length + dataHeader.length + opts.samples.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, list, dataHeader, opts.samples]);
}

function int16(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

describe('parseWavHeader', () => {
  it('finds the data chunk past other chunks', () => {
    const file = wav({ rate: 44_100, channels: 2, samples: int16([1, 2, 3, 4]), extraChunk: true });
    const info = parseWavHeader(file);
    assert.ok(info);
    assert.equal(info.sampleRate, 44_100);
    assert.equal(info.channels, 2);
    assert.equal(info.bitsPerSample, 16);
    assert.deepEqual(file.subarray(info.dataOffset), int16([1, 2, 3, 4]));
  });

  it('asks for more bytes when the header is cut short', () => {
    const file = wav({ rate: 16_000, channels: 1, samples: int16([1]) });
    assert.equal(parseWavHeader(file.subarray(0, 20)), null);
  });

  it('rejects encodings it cannot convert', () => {
    assert.throws(() => parseWavHeader(wav({ rate: 16_000, channels: 1, bits: 8, samples: Buffer.alloc(4) })), /unsupported/);
    assert.throws(() => parseWavHeader(Buffer.from('OggS0000WAVExxxx')), /not a RIFF/);
  });
});

describe('PcmConverter', () => {
  it('passes 16 kHz mono through byte for byte', () => {
    const conv = new PcmConverter({ sampleRate: 16_000, channels: 1 });
    assert.equal(conv.isPassthrough, true);
    const input = int16([100, -100, 2000]);
    assert.deepEqual(conv.push(input), input);
  });

  it('holds back a split sample until the rest arrives', () => {
    const conv = new PcmConverter({ sampleRate: 16_000, channels: 1 });
    const input = int16([1234, 5678]);
    assert.equal(conv.push(input.subarray(0, 3)).length, 2);
    assert.deepEqual(conv.push(input.subarray(3)), int16([5678]));
  });

  it('averages channels into mono', () => {
    const conv = new PcmConverter({ sampleRate: 16_000, channels: 2 });
    const out = conv.push(int16([1000, 3000, -2000, 0]));
    assert.equal(out.readInt16LE(0), 2000);
    assert.equal(out.readInt16LE(2), -1000);
  });

  it('resamples 48 kHz to a third of the samples, seamlessly across chunks', () => {
    const samples = Array.from({ length: 4800 }, (_, i) => Math.round(Math.sin(i / 20) * 8000));
    const whole = new PcmConverter({ sampleRate: 48_000, channels: 1 }).push(int16(samples));
    const conv = new PcmConverter({ sampleRate: 48_000, channels: 1 });
    const parts = [conv.push(int16(samples.slice(0, 1777))), conv.push(int16(samples.slice(1777)))];
    const chunked = Buffer.concat(parts);
    assert.ok(Math.abs(whole.length / 2 - 1600) <= 1, `got ${whole.length / 2} samples`);
    assert.deepEqual(chunked, whole);
  });

  it('upsamples 8 kHz to twice the samples', () => {
    const out = new PcmConverter({ sampleRate: 8_000, channels: 1 }).push(int16(new Array(800).fill(500)));
    assert.ok(Math.abs(out.length / 2 - 1600) <= 2);
    assert.equal(out.readInt16LE(100), 500);
  });

  it('reads 32-bit float input', () => {
    const buf = Buffer.alloc(8);
    buf.writeFloatLE(0.5, 0);
    buf.writeFloatLE(-0.5, 4);
    const out = new PcmConverter({ sampleRate: 16_000, channels: 1 }, 'float32').push(buf);
    assert.equal(out.readInt16LE(0), Math.round(0.5 * 0x7fff));
    assert.equal(out.readInt16LE(2), -0x4000);
  });
});

describe('AudioNormalizer', () => {
  it('detects a WAV header split across chunks and converts to 16 kHz mono', () => {
    const stereo = int16(new Array(96).fill(0).map((_, i) => (i % 2 ? 1000 : 3000)));
    const file = wav({ rate: 32_000, channels: 2, samples: stereo, extraChunk: true });
    const out: Buffer[] = [];
    const formats: string[] = [];
    const norm = new AudioNormalizer({ sampleRate: 16_000, channels: 1 }, (b) => out.push(b), (d) => formats.push(d));
    for (let i = 0; i < file.length; i += 5) norm.push(file.subarray(i, i + 5));
    const pcm = Buffer.concat(out);
    assert.match(formats[0]!, /WAV 16-bit PCM 32000 Hz × 2 → 16 kHz mono/);
    assert.ok(pcm.length / 2 >= 23 && pcm.length / 2 <= 24);
    assert.equal(pcm.readInt16LE(0), 2000);
  });

  it('treats anything without RIFF as raw PCM in the given format', () => {
    const out: Buffer[] = [];
    const formats: string[] = [];
    const norm = new AudioNormalizer({ sampleRate: 16_000, channels: 1 }, (b) => out.push(b), (d) => formats.push(d));
    norm.push(int16([7, 8, 9]));
    assert.match(formats[0]!, /raw PCM16LE 16000 Hz × 1 \(sent as-is\)/);
    assert.deepEqual(Buffer.concat(out), int16([7, 8, 9]));
  });
});

describe('recorders', () => {
  it('prefers PipeWire/Pulse/ALSA on Linux and falls back to sox/ffmpeg', () => {
    assert.deepEqual(
      micRecorderCandidates('linux').map((c) => c.name),
      ['pw-record', 'parec', 'arecord', 'sox', 'ffmpeg'],
    );
    assert.deepEqual(
      micRecorderCandidates('darwin').map((c) => c.name),
      ['sox', 'ffmpeg'],
    );
  });

  it('finds executables on PATH', () => {
    assert.ok(findOnPath('node', process.env['PATH']));
    assert.equal(findOnPath('definitely-not-a-real-binary-xyz'), null);
  });
});
