/**
 * The phone's voice cues — listening / sent / cancel / error — for channel
 * voice calls, so a Discord call sounds like the phone does
 * (packages/client/src/cues.ts names them; cueAudio.generated.ts holds the PCM).
 */

import type { PcmStream } from '../providers/speech/output/types.js';
import { CUE_PCM_BASE64, CUE_RATE } from './cueAudio.generated.js';

export type CallCue = 'listening' | 'sent' | 'cancel' | 'error';

const decoded = new Map<CallCue, Buffer>();

export function cuePcm(cue: CallCue): Buffer {
  let pcm = decoded.get(cue);
  if (!pcm) {
    pcm = Buffer.from(CUE_PCM_BASE64[cue] ?? '', 'base64');
    decoded.set(cue, pcm);
  }
  return pcm;
}

/** A cue as a one-chunk stream, playable through the same sink as a reply. */
export function cueStream(cue: CallCue): PcmStream {
  const pcm = cuePcm(cue);
  return {
    sampleRate: CUE_RATE,
    chunks: (async function* () {
      yield pcm;
    })(),
  };
}
