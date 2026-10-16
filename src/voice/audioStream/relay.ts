/**
 * What the stream socket sends for one transcript, and in which order.
 *
 * The text goes to the client the moment it exists — before the agent is
 * spawned or the turn queued. Delivery is the slow part of the hop (a process
 * spawn forks the bridge, then the turn-history insert and the transcript
 * write are synchronous) and none of it changes what was said, so the phone
 * shows the words without waiting for it. The `segment` frame that follows
 * carries the same text plus how it was delivered, so a client that only
 * knows `segment` (an older PWA or `squeakr pipe`) still works.
 *
 * Transport-free: the route passes its socket send and delivery function;
 * tests pass fakes.
 */

import type { PipeTranscript } from './pipe.js';

export type StreamDeliveryOutcome =
  | { ok: true; delivery: string }
  | { ok: false; reason: string; message: string };

export function relayStreamTranscript<O extends StreamDeliveryOutcome>(
  t: PipeTranscript,
  send: (frame: Record<string, unknown>) => void,
  deliver: (text: string) => O,
): O {
  const base = {
    index: t.index,
    text: t.text,
    audio_ms: t.audioMs,
    latency_ms: t.latencyMs,
    provider: t.provider ?? null,
    merged: t.merged,
  };
  send({ type: 'transcript', ...base });
  const outcome = deliver(t.text);
  send({
    type: 'segment',
    ...base,
    delivered: outcome.ok,
    ...(outcome.ok ? { delivery: outcome.delivery } : { reason: outcome.reason, message: outcome.message }),
  });
  return outcome;
}
