/**
 * Narrator — converts NarrationEvents into spoken messages for Dad.
 *
 * Receives events from the Watcher and injects them into the active
 * realtime session. When no session is active (mic is off), events are
 * buffered up to `narratorMaxBufferEvents` and replayed as a summary
 * when the next session connects.
 *
 * Architecture (Milestone 4): narration travels phone → provider via the
 * control WebSocket relay. The bridge sends `{ type: "narration", text, kind }`
 * to the phone over the authenticated control WS. The phone injects it into
 * the provider session via `conversation.item.create` + `response.create`
 * on the WebRTC data channel.
 *
 * The `PhoneRelaySession` class (below) implements `NarratorSession` for
 * this relay model. It holds a reference to the active control WS `send`
 * function.
 *
 * See docs/12-stream-json-watcher.md — Narrator section.
 */

import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { notifyPhone } from '../push/notifyPhone.js';
import type { NarrationEvent } from './watcher.js';

const log = childLogger('narrator');

// ── Session interface ─────────────────────────────────────────────────────
//
// A thin interface over the realtime WebSocket — filled in by Milestone 4.
// The narrator holds a reference to the active session; swapping sessions
// is just a setSession() call.

export interface NarratorSession {
  /**
   * True when the session is open and ready to receive injections.
   * False while the mic is off or the session is initialising.
   */
  readonly isReady: boolean;

  /**
   * True when the session is currently speaking (i.e., a prior injection
   * has not yet finished TTS). Narrator defers until this is false.
   */
  readonly isSpeaking: boolean;

  /**
   * Inject an assistant text turn. The provider will TTS it immediately.
   * Resolves when the injection has been sent (not when TTS completes).
   */
  injectText(text: string): Promise<void>;
  /** Optional narration kind (job_started, job_done, ghost_killed, …). */
  injectTextWithKind?(text: string, kind: string): Promise<void>;
}

// ── Narrator ──────────────────────────────────────────────────────────────

export class Narrator {
  private session: NarratorSession | null = null;
  private readonly buffer: NarrationEvent[] = [];
  private readonly maxBuffer: number;

  constructor() {
    const { settings } = getConfig();
    this.maxBuffer = settings.narratorMaxBufferEvents;
  }

  /**
   * Attach (or detach) the active realtime session.
   * Call with null when the session closes; call with the new session when it
   * opens. On attach, buffered events are replayed as a summary.
   */
  async setSession(session: NarratorSession | null): Promise<void> {
    this.session = session;

    if (session && this.buffer.length > 0) {
      await this.replayBuffer();
    }
  }

  /**
   * Receive a narration event from the Watcher.
   * If a session is ready, inject immediately.
   * If not, buffer (up to maxBuffer).
   */
  async receive(event: NarrationEvent): Promise<void> {
    const { settings } = getConfig();
    if (!settings.narratorEnabled) return;
    // Count-only cadence ticks are reserved for get_agent_status — voice agent speaks milestones.
    if (event.kind === 'progress_tick') return;

    if (this.session?.isReady) {
      await this.inject(event);
    } else {
      this.bufferEvent(event);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async inject(event: NarrationEvent): Promise<void> {
    const session = this.session;
    if (!session?.isReady) {
      this.bufferEvent(event);
      return;
    }

    // Defer if TTS is still playing from a prior injection.
    if (session.isSpeaking) {
      log.debug({ kind: event.kind }, 'narrator: session speaking — deferring injection');
      // Re-queue after a short delay rather than silently dropping.
      await new Promise((res) => setTimeout(res, 1500));
      await this.inject(event); // Retry once
      return;
    }

    try {
      log.debug({ kind: event.kind, text: event.text }, 'narrator: injecting');
      if (session.injectTextWithKind) {
        await session.injectTextWithKind(event.text, event.kind);
      } else {
        await session.injectText(event.text);
      }
    } catch (err) {
      log.error({ err, kind: event.kind }, 'narrator: injection failed');
      this.bufferEvent(event);
    }
  }

  private bufferEvent(event: NarrationEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift(); // Drop oldest when buffer is full
    }
    log.debug({ buffered: this.buffer.length }, 'narrator: event buffered (no active session)');
  }

  /**
   * When a new session connects, replay buffered events as a concise summary
   * rather than a flood of individual messages.
   */
  private async replayBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    const session = this.session;
    if (!session?.isReady) return;

    // Build a compact summary from buffered events.
    const doneEvent = [...this.buffer].reverse().find((e: NarrationEvent) => e.kind === 'job_done' || e.kind === 'job_error');
    const writesCount = this.buffer.filter((e) => e.kind === 'file_write').length;
    const shellCount = this.buffer.filter((e) => e.kind === 'shell_run').length;

    let summaryText: string;
    if (doneEvent) {
      summaryText = doneEvent.text;
      if (writesCount > 0 || shellCount > 0) {
        const parts: string[] = [];
        if (writesCount > 0) parts.push(`${writesCount} file${writesCount !== 1 ? 's' : ''} written`);
        if (shellCount > 0) parts.push(`${shellCount} command${shellCount !== 1 ? 's' : ''} run`);
        summaryText += ` While you were away: ${parts.join(', ')}.`;
      }
    } else {
      // Job still running when session reconnected.
      summaryText = `${getActiveProvider().displayName} is still working.`;
      if (writesCount > 0) summaryText += ` So far: ${writesCount} file${writesCount !== 1 ? 's' : ''} written.`;
    }

    this.buffer.length = 0;

    try {
      await session.injectText(summaryText);
    } catch (err) {
      log.error({ err }, 'narrator: buffer replay failed');
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let _narrator: Narrator | null = null;

export function getNarrator(): Narrator {
  if (!_narrator) _narrator = new Narrator();
  return _narrator;
}

// ── PhoneRelaySession (Milestone 4 implementation) ────────────────────────
//
// Sends narration events to the phone over the authenticated control WS.
// The phone forwards them to the provider via the WebRTC data channel
// (conversation.item.create + response.create).
//
// The bridge does NOT need its own realtime WS connection — the phone is
// the relay (keeping audio/WebRTC entirely phone-side as per the design).

export type WsSendFn = (data: string) => void;

export class PhoneRelaySession implements NarratorSession {
  private _isSpeaking = false;
  private readonly send: WsSendFn;

  constructor(send: WsSendFn) {
    this.send = send;
  }

  get isReady(): boolean {
    // The WS being open is the readiness indicator.
    // The server.ts caller sets this to null when the WS closes.
    return true;
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  /** Called by the phone when TTS starts/ends (via a 'speaking' WS message). */
  setSpeaking(speaking: boolean): void {
    this._isSpeaking = speaking;
  }

  async injectText(text: string): Promise<void> {
    await notifyPhone({ type: 'narration', text });
  }

  async injectTextWithKind(text: string, kind: string): Promise<void> {
    await notifyPhone({ type: 'narration', text, kind });
  }
}
