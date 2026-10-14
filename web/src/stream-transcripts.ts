/**
 * Turns /ws/audio-stream text frames into "show this" / "this was not
 * delivered" events, once per segment.
 *
 * The bridge sends `transcript` the moment a segment is transcribed and
 * `segment` (same index, same text, plus the delivery outcome) once the agent
 * has been spawned or the turn queued. The words are shown on whichever frame
 * arrives first — `transcript` from a current bridge, `segment` from an older
 * one that never sends `transcript` — and never twice.
 */

export interface StreamSegmentInfo {
  index: number;
  audioMs: number;
  latencyMs: number;
}

export interface StreamTranscriptEvents {
  /** The user's words for one segment — fired once, as early as possible. */
  onSegment(text: string, info: StreamSegmentInfo): void;
  /** The bridge transcribed the segment but could not hand it to the agent. */
  onUndelivered?(message: string, index: number): void;
}

export class StreamTranscriptTracker {
  private readonly shown = new Set<number>();

  constructor(private readonly events: StreamTranscriptEvents) {}

  /** Feed a parsed bridge frame. Returns true if it was a transcript or segment frame. */
  handle(msg: Record<string, unknown>): boolean {
    const type = msg['type'];
    if (type !== 'transcript' && type !== 'segment') return false;
    const text = typeof msg['text'] === 'string' ? msg['text'] : '';
    const index = Number(msg['index'] ?? 0);

    if (text && !this.shown.has(index)) {
      this.shown.add(index);
      this.events.onSegment(text, {
        index,
        audioMs: Number(msg['audio_ms'] ?? 0),
        latencyMs: Number(msg['latency_ms'] ?? 0),
      });
    }
    if (type === 'segment') {
      // Indices only grow; nothing more will arrive for this one.
      this.shown.delete(index);
      if (msg['delivered'] === false && typeof msg['message'] === 'string') {
        this.events.onUndelivered?.(msg['message'], index);
      }
    }
    return true;
  }
}
