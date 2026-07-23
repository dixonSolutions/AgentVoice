/** Short spoken form for pipeline error messages. */
export function errorSpeechText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'Something went wrong.';
  const lower = trimmed.toLowerCase();
  if (/^\s*413\b/.test(trimmed) || lower.includes('request entity too large') || lower.includes('payload too large')) {
    return 'That recording was too long to send. Say send sooner, or keep the request shorter.';
  }
  if (lower.includes('http/2 stream') || lower.includes('abnormally aborted')) {
    return 'Transcription failed. Check the bridge network and try again.';
  }
  if (lower.includes('could not reach aws') || lower.includes('network error reaching aws')) {
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  }
  // Never speak bare HTTP status codes.
  if (/^\d{3}\b/.test(trimmed) && trimmed.length < 40) {
    return 'Speech input failed. Please try again.';
  }
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}
