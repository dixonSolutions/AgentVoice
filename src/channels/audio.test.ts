import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  decodeOggOpusTo16k,
  downmixPcm16,
  encodeOggOpus,
  monoToStereoPcm16,
  OpusDecoder,
  OpusEncoder,
  PcmFramer,
  readOggPackets,
  resamplePcm16,
} from './audio.js';

function tone(rate: number, ms: number, hz = 440, amp = 12000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp), i * 2);
  return b;
}

function rms(pcm: Buffer): number {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) sum += pcm.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / Math.max(1, n));
}

/** Zero crossings per second ≈ 2 × frequency. */
function frequency(pcm: Buffer, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length >> 1; i++) {
    if ((pcm.readInt16LE((i - 1) * 2) < 0) !== (pcm.readInt16LE(i * 2) < 0)) crossings++;
  }
  return crossings / 2 / ((pcm.length >> 1) / rate);
}

describe('PCM helpers', () => {
  it('resamples keeping duration and pitch', () => {
    const src = tone(48_000, 500, 300);
    const down = resamplePcm16(src, 48_000, 16_000);
    assert.equal(down.length / 2, 8000);
    assert.ok(Math.abs(frequency(down, 16_000) - 300) < 10, `pitch ${frequency(down, 16_000)}`);
    const up = resamplePcm16(tone(24_000, 500, 300), 24_000, 48_000);
    assert.equal(up.length / 2, 24_000);
    assert.ok(Math.abs(frequency(up, 48_000) - 300) < 10);
  });

  it('downmixes and upmixes channels', () => {
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(100, 0);
    stereo.writeInt16LE(300, 2);
    stereo.writeInt16LE(-50, 4);
    stereo.writeInt16LE(-150, 6);
    assert.deepEqual([...new Int16Array(downmixPcm16(stereo, 2).buffer.slice(0))], [200, -100]);
    const mono = Buffer.alloc(4);
    mono.writeInt16LE(7, 0);
    mono.writeInt16LE(-7, 2);
    assert.deepEqual([...new Int16Array(monoToStereoPcm16(mono).buffer.slice(0))], [7, 7, -7, -7]);
  });

  it('frames PCM into exact 20 ms pieces and pads the tail', () => {
    const f = new PcmFramer(1920);
    assert.equal(f.push(Buffer.alloc(1000)).length, 0);
    const frames = f.push(Buffer.alloc(3000));
    assert.equal(frames.length, 2);
    assert.equal(f.flush()?.length, 1920);
    assert.equal(f.flush(), null);
  });
});

describe('Opus', () => {
  it('round-trips a Discord-style 48 kHz stereo frame', () => {
    const enc = new OpusEncoder(2, 64_000);
    const dec = new OpusDecoder(2);
    const frame = monoToStereoPcm16(tone(48_000, 20, 440));
    let out: Buffer = Buffer.alloc(0);
    for (let i = 0; i < 10; i++) out = dec.decode(enc.encode(frame));
    assert.equal(out.length, frame.length);
    assert.ok(rms(out) > 3000, `decoded energy ${rms(out)}`);
    enc.close();
    dec.close();
  });

  it('writes an Ogg/Opus voice note that decodes back to the same speech', () => {
    const speech = tone(24_000, 1500, 220);
    const ogg = encodeOggOpus(speech, 24_000);
    assert.equal(ogg.toString('ascii', 0, 4), 'OggS');
    const packets = readOggPackets(ogg);
    assert.equal(packets[0]!.toString('ascii', 0, 8), 'OpusHead');
    assert.equal(packets[1]!.toString('ascii', 0, 8), 'OpusTags');
    assert.equal(packets.length - 2, 75, '1.5 s in 20 ms packets');
    const back = decodeOggOpusTo16k(ogg);
    const seconds = back.length / 2 / 16_000;
    assert.ok(Math.abs(seconds - 1.5) < 0.05, `duration ${seconds}`);
    assert.ok(Math.abs(frequency(back.subarray(3200), 16_000) - 220) < 10, `pitch ${frequency(back, 16_000)}`);
  });

  it('every Ogg page carries a valid CRC (players reject the file otherwise)', () => {
    const ogg = encodeOggOpus(tone(16_000, 3000), 16_000);
    let offset = 0;
    let pages = 0;
    while (offset < ogg.length) {
      const segments = ogg[offset + 26]!;
      let len = 27 + segments;
      for (let i = 0; i < segments; i++) len += ogg[offset + 27 + i]!;
      const page = Buffer.from(ogg.subarray(offset, offset + len));
      const stored = page.readUInt32LE(22);
      page.writeUInt32LE(0, 22);
      // Recompute with a fresh encoder pass over the page bytes.
      let crc = 0;
      for (const byte of page) {
        crc ^= byte << 24;
        for (let b = 0; b < 8; b++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
      }
      assert.equal(stored, crc >>> 0, `page ${pages}`);
      offset += len;
      pages++;
    }
    assert.ok(pages >= 4);
    assert.equal(ogg[ogg.lastIndexOf('OggS') + 5]! & 0x04, 0x04, 'last page marks end of stream');
  });
});
