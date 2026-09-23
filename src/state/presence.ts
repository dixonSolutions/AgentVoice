/**
 * Presence — the single source of truth for "is the user listening?".
 *
 * Before this module every caller answered that question differently.
 * `hasActiveVoiceSession()` counted any registered broadcaster, desk
 * `/ws/events` clients included, so a VS Code window open on another machine
 * made the bridge believe someone was holding a phone; and the control socket
 * is a single slot, so one of two browser tabs closing looked exactly like the
 * user hanging up. Neither could tell a tunnel blip from a real departure.
 *
 * Presence is tracked per connected client, each tagged with its kind, and
 * collapsed into one listener state:
 *
 *   connected ──(last phone client goes)──▶ grace ──(graceMs)──▶ away
 *       ▲                                    │
 *       └────────────(reconnect)─────────────┘
 *
 *   connected ──({type:'hangup'} from the PWA)──▶ hung_up
 *
 * `grace` exists because mobile networks are what they are: switching from
 * Wi-Fi to cellular, an iOS app suspension, or the PWA's own reconnect all
 * drop the socket for a few seconds. Policies must not fire for those.
 *
 * Desk clients are deliberately NOT listeners. A desk client can read
 * everything and it suppresses push notifications (the user is clearly at a
 * screen), but the away policies in docs/36 act on *phone* presence only.
 *
 * An `audio_pipe` (`agentvoice pipe`, docs/41) that listens for replies IS a
 * listener: someone is speaking into it and hearing the agent back, exactly
 * like the phone, just from a terminal.
 *
 * See docs/36-disconnect-and-background-work.md §1.
 */

import { childLogger } from '../log.js';

const log = childLogger('presence');

export type ClientKind = 'phone_control' | 'phone_intelligence' | 'desk' | 'audio_pipe';

export type ListenerState = 'connected' | 'grace' | 'away' | 'hung_up';

export interface PresenceSnapshot {
  state: ListenerState;
  /** Epoch ms the listener stopped being `connected`, or null while connected. */
  awaySince: number | null;
  /** How long the listener has been away (grace included), 0 while connected. */
  awayMs: number;
  /** Live client counts per kind. */
  clients: Record<ClientKind, number>;
  /** True when a desk client is watching, even if no phone is. */
  deskPresent: boolean;
}

export interface PresenceClientOptions {
  kind: ClientKind;
  /** Send a ping frame to this client. Omit for clients without a ping channel. */
  ping?: () => void;
  /** Close the socket — called after two missed pongs. */
  close?: (code: number, reason: string) => void;
}

export interface PresenceClient {
  readonly id: string;
  readonly kind: ClientKind;
  /** Record a pong / any inbound frame — proof the client is alive. */
  alive(): void;
  /** The PWA sent `{type:'hangup'}`: apply the away policy with no grace. */
  hangUp(): void;
  /** Deregister — called from the socket's `close` handler. */
  release(): void;
}

/** Server ping interval. Two missed pongs (30 s) close a half-open socket. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
const MISSED_PONGS_BEFORE_CLOSE = 2;

/** Kinds that mean someone is listening. The name predates the audio pipe. */
const PHONE_KINDS: ReadonlySet<ClientKind> = new Set(['phone_control', 'phone_intelligence', 'audio_pipe']);

interface TrackedClient {
  id: string;
  kind: ClientKind;
  missedPongs: number;
  ping?: () => void;
  close?: (code: number, reason: string) => void;
}

export interface PresenceTrackerOptions {
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Grace window before `grace` becomes `away`. */
  graceMs?: number;
}

type Listener = (snapshot: PresenceSnapshot, previous: ListenerState) => void;

export class PresenceTracker {
  private clients = new Map<string, TrackedClient>();
  private state: ListenerState = 'away';
  private awaySince: number | null;
  private graceTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private listeners = new Set<Listener>();
  private nextId = 1;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private graceMs: number;

  constructor(opts: PresenceTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending grace timer must never hold the process open on shutdown.
        if (typeof t.unref === 'function') t.unref();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.graceMs = opts.graceMs ?? 45_000;
    this.awaySince = this.now();
  }

  /** Change the grace window at runtime (settings save). */
  setGraceMs(ms: number): void {
    this.graceMs = Math.max(0, ms);
  }

  getGraceMs(): number {
    return this.graceMs;
  }

  register(opts: PresenceClientOptions): PresenceClient {
    const id = `${opts.kind}-${this.nextId++}`;
    const tracked: TrackedClient = {
      id,
      kind: opts.kind,
      missedPongs: 0,
      ping: opts.ping,
      close: opts.close,
    };
    this.clients.set(id, tracked);
    log.debug({ id, kind: opts.kind, clients: this.clients.size }, 'presence client registered');

    if (PHONE_KINDS.has(opts.kind)) this.onPhoneArrived();
    this.ensureHeartbeat();

    let released = false;
    return {
      id,
      kind: opts.kind,
      alive: () => {
        const c = this.clients.get(id);
        if (c) c.missedPongs = 0;
      },
      hangUp: () => {
        if (released) return;
        released = true;
        this.clients.delete(id);
        log.info({ id, kind: opts.kind }, 'client hung up');
        if (PHONE_KINDS.has(opts.kind)) this.onPhoneLeft({ explicit: true });
        this.ensureHeartbeat();
      },
      release: () => {
        if (released) return;
        released = true;
        this.clients.delete(id);
        log.debug({ id, kind: opts.kind, clients: this.clients.size }, 'presence client released');
        if (PHONE_KINDS.has(opts.kind)) this.onPhoneLeft({ explicit: false });
        this.ensureHeartbeat();
      },
    };
  }

  private phoneCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (PHONE_KINDS.has(c.kind)) n++;
    return n;
  }

  private onPhoneArrived(): void {
    this.cancelGrace();
    this.transition('connected');
  }

  private onPhoneLeft(opts: { explicit: boolean }): void {
    if (this.phoneCount() > 0) return; // another tab / socket still holds the phone
    if (opts.explicit) {
      this.cancelGrace();
      this.transition('hung_up');
      return;
    }
    if (this.graceMs <= 0) {
      this.transition('away');
      return;
    }
    this.transition('grace');
    this.cancelGrace();
    this.graceTimer = this.setTimer(() => {
      this.graceTimer = null;
      if (this.phoneCount() === 0 && this.state === 'grace') this.transition('away');
    }, this.graceMs);
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) {
      this.clearTimer(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private transition(next: ListenerState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    if (next === 'connected') {
      this.awaySince = null;
    } else if (previous === 'connected' || this.awaySince === null) {
      this.awaySince = this.now();
    }
    log.info({ from: previous, to: next }, 'listener presence changed');
    const snapshot = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snapshot, previous);
      } catch (err) {
        log.warn({ err }, 'presence listener failed');
      }
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): PresenceSnapshot {
    const clients: Record<ClientKind, number> = {
      phone_control: 0,
      phone_intelligence: 0,
      desk: 0,
      audio_pipe: 0,
    };
    for (const c of this.clients.values()) clients[c.kind]++;
    const awayMs = this.awaySince === null ? 0 : Math.max(0, this.now() - this.awaySince);
    return {
      state: this.state,
      awaySince: this.awaySince,
      awayMs,
      clients,
      deskPresent: clients.desk > 0,
    };
  }

  getState(): ListenerState {
    return this.state;
  }

  /**
   * True while the user can still hear us — `connected` or inside the grace
   * window. Voice tools keep working through grace so a tunnel blip does not
   * turn into "the user is gone".
   */
  isListening(): boolean {
    return this.state === 'connected' || this.state === 'grace';
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  private ensureHeartbeat(): void {
    const wanted = this.clients.size > 0;
    if (wanted && this.heartbeatTimer === null) {
      this.scheduleHeartbeat();
    } else if (!wanted && this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      this.beat();
      if (this.clients.size > 0) this.scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** One heartbeat round — exported for tests via `tick()`. */
  private beat(): void {
    for (const c of [...this.clients.values()]) {
      if (!c.ping) continue;
      if (c.missedPongs >= MISSED_PONGS_BEFORE_CLOSE) {
        log.warn({ id: c.id, kind: c.kind }, 'client missed heartbeats — closing half-open socket');
        try {
          c.close?.(4002, 'heartbeat timeout');
        } catch (err) {
          log.debug({ err }, 'close after heartbeat timeout failed');
        }
        continue;
      }
      c.missedPongs++;
      try {
        c.ping();
      } catch (err) {
        log.debug({ err, id: c.id }, 'ping failed');
      }
    }
  }

  /** Test hook: run one heartbeat round synchronously. */
  tick(): void {
    this.beat();
  }

  /** Test hook: drop everything (used by unit tests between cases). */
  reset(): void {
    this.cancelGrace();
    if (this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clients.clear();
    this.listeners.clear();
    this.state = 'away';
    this.awaySince = this.now();
  }
}

// ── Process-wide singleton ──────────────────────────────────────────────────

let _tracker: PresenceTracker | null = null;

export function getPresence(): PresenceTracker {
  if (!_tracker) _tracker = new PresenceTracker();
  return _tracker;
}

/** Convenience wrappers so call sites do not each reach for the singleton. */
export function listenerState(): ListenerState {
  return getPresence().getState();
}

export function isListenerPresent(): boolean {
  return getPresence().isListening();
}

export function presenceSnapshot(): PresenceSnapshot {
  return getPresence().snapshot();
}
