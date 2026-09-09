/**
 * Event bus — fan-out of bridge events to every connected *desk* client.
 *
 * The phone has two single-client sockets (`/ws/control`, `/ws/intelligence`)
 * whose registration is last-writer-wins by design: one narrator, one approval
 * push target. A second UI (the VS Code / Cursor extension, docs/34) must not
 * displace the phone, so it observes through this bus instead — every payload
 * that goes to the phone via notifyPhone(), plus the normalized agent stream
 * events (providers/agents/events.ts) from the voice agent and worker jobs.
 *
 * Subscribers are plain callbacks; `/ws/events` (routes/eventsSocket.ts) is the
 * only transport today. Nothing here is CLI-specific.
 */

import { childLogger } from '../log.js';

const log = childLogger('event-bus');

export interface BridgeEvent {
  type: string;
  /** ISO timestamp — stamped on publish when absent. */
  ts?: string;
  [key: string]: unknown;
}

type Listener = (event: BridgeEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to every published event. Returns the unsubscribe function. */
export function subscribeEvents(fn: Listener): () => void {
  listeners.add(fn);
  log.debug({ subscribers: listeners.size }, 'event subscriber added');
  return () => {
    listeners.delete(fn);
    log.debug({ subscribers: listeners.size }, 'event subscriber removed');
  };
}

/** Publish to all subscribers. Listener errors are logged, never propagated. */
export function publishEvent(event: BridgeEvent): void {
  if (listeners.size === 0) return;
  const stamped: BridgeEvent = event.ts ? event : { ...event, ts: new Date().toISOString() };
  for (const fn of listeners) {
    try {
      fn(stamped);
    } catch (err) {
      log.warn({ err, type: event.type }, 'event subscriber threw');
    }
  }
}

export function eventSubscriberCount(): number {
  return listeners.size;
}
