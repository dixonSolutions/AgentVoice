/**
 * PCM16LE → WAV container.
 *
 * The PWA uploads raw 16 kHz mono PCM (see web/src/server-stt.ts). Amazon
 * Transcribe streams that as-is, but every HTTP transcription API wants a real
 * container, so wrap it in a 44-byte RIFF header rather than transcoding.
 */

export const STT_SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

export function pcm16ToWav(pcm: Buffer, sampleRate = STT_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Seconds of audio in a PCM16 mono buffer. */
export function pcmDurationSec(pcm: Buffer, sampleRate = STT_SAMPLE_RATE): number {
  return pcm.length / 2 / sampleRate;
}

/**
 * A short spoken-like probe used by "Test provider" — a 600 ms 220 Hz tone with
 * an amplitude envelope. Real audio (not digital silence) so providers that
 * reject empty input still exercise the full auth + transcription path; the
 * transcript itself is expected to come back empty.
 */
export function probePcm16(sampleRate = STT_SAMPLE_RATE): Buffer {
  const samples = Math.floor(sampleRate * 0.6);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin((Math.PI * i) / samples);
    const value = Math.sin(2 * Math.PI * 220 * t) * envelope * 0.25;
    pcm.writeInt16LE(Math.round(value * 0x7fff), i * 2);
  }
  return pcm;
}
