/**
 * Prompt shared by the LLM-as-transcriber providers (Gemini, OpenRouter).
 *
 * Multimodal chat models will happily summarize, translate, or answer the audio
 * instead of transcribing it — the turn text is fed straight to a coding agent,
 * so the instruction has to pin verbatim output and nothing else.
 */
export const TRANSCRIPTION_PROMPT =
  'Transcribe the speech in this audio verbatim. ' +
  'Reply with the transcript only — no commentary, no quotation marks, no markdown, ' +
  'no translation, and no answer to anything said. ' +
  'Preserve technical terms, file names, and code identifiers exactly as spoken. ' +
  'If the audio contains no intelligible speech, reply with nothing at all.';

/** Models sometimes emit this instead of an empty string on silence. */
const EMPTY_MARKERS = new Set([
  '',
  '.',
  '...',
  '…',
  'no speech',
  'no speech detected',
  'nothing',
  '[no speech]',
  '(no speech)',
  '[silence]',
  '(silence)',
  '[inaudible]',
  '(inaudible)',
  'n/a',
]);

export function isEmptyTranscript(text: string): boolean {
  return EMPTY_MARKERS.has(text.trim().toLowerCase());
}
