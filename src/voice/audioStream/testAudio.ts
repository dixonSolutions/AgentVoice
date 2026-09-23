/** Synthetic PCM16LE mono audio for tests — a tone reads as speech, zeros as silence. */

export const RATE = 16_000;

export function tone(ms: number, amplitude = 0.3, hz = 220): Buffer {
  const samples = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

/** Split a buffer into chunks of irregular sizes (odd lengths included). */
export function jaggedChunks(buf: Buffer, sizes = [333, 1024, 7, 4096, 2001]): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  let i = 0;
  while (offset < buf.length) {
    const size = sizes[i++ % sizes.length]!;
    out.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  return out;
}
