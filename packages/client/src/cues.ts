/**
 * Voice cue definitions, shared by every client.
 *
 * The phone plays these through HTMLAudio and the editor through a host-side
 * player, but *which* cues exist, what they are called on disk and how often
 * one may repeat is a single decision — so it lives here rather than being
 * restated in each client.
 *
 * Assets: web/public/sounds/*.mp3 (Kenney UI Audio, CC0 — see sounds/README.md),
 * copied into the extension at build time by vscode/esbuild.mjs.
 */

export const VOICE_CUES = ['listening', 'sent', 'cancel', 'error'] as const;
export type VoiceCue = (typeof VOICE_CUES)[number];

/** File name for a cue, relative to whichever sounds directory the client uses. */
export const CUE_FILENAME: Record<VoiceCue, string> = {
  listening: 'listening.mp3',
  sent: 'sent.mp3',
  cancel: 'cancel.mp3',
  error: 'error.mp3',
};

/**
 * Minimum gap between repeats of the same cue.
 *
 * Recognition can fire twice in quick succession (a partial then a final), and
 * hearing the same chirp twice reads as a stutter rather than as two events.
 */
export const CUE_DEBOUNCE_MS = 450;

/**
 * Whether a cue may sound now. `force` is for errors, which matter more than
 * the debounce — two failures in a row should be audible as two.
 */
export function shouldPlayCue(
  lastPlayedAt: number | undefined,
  now: number,
  opts: { force?: boolean } = {},
): boolean {
  if (opts.force) return true;
  return lastPlayedAt === undefined || now - lastPlayedAt >= CUE_DEBOUNCE_MS;
}
