/**
 * Float mic samples → PCM16LE at 16 kHz, the format every bridge audio path
 * takes (/api/intelligence/transcribe and /ws/audio-stream).
 */

export const PCM_SAMPLE_RATE = 16_000;

export function floatToPcm16Sample(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = floatToPcm16Sample(input[i] ?? 0);
  }
  return out;
}

/** Nearest-sample decimation — adequate for speech going to an STT engine. */
export function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === PCM_SAMPLE_RATE) return floatToPcm16(input);
  const ratio = inputRate / PCM_SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    out[i] = floatToPcm16Sample(input[srcIdx] ?? 0);
  }
  return out;
}

export function concatPcm16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
