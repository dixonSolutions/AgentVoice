/**
 * Narrator — decides what the *bridge* says out loud about running work.
 *
 * Receives events from the Watcher. Two things changed in docs/36 + docs/39:
 *
 *   1. The event and its speech are separate. Every event is delivered to the
 *      phone as `{type:'narration', kind, text, speak, data}`; `speak` decides
 *      whether TTS plays it. Turning narration off used to also kill the
 *      `job_done` push notification and the PWA's "a job is running" state,
 *      because both were derived from the same suppressed message.
 *   2. The gate is per event, not one global switch, and `auto` means "only if
 *      no voice agent is already narrating" — which is the actual fix for the
 *      duplicate "started working on …" line in the agent_native workflow.
 *
 * When nobody is listening, events are buffered up to
 * `narratorMaxBufferEvents` and replayed as one digest when the phone comes
 * back (docs/36 §3.5).
 *
 * See docs/12-stream-json-watcher.md and docs/39 Part B.
 */

import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { notifyPhone } from '../push/notifyPhone.js';
import { phrase, shouldSpeakNarration, narrationPayload } from '../voice/phrases.js';
import type { NarrationKind as CatalogKind } from '../config.js';
import { recordNarration } from '../logging/transcripts.js';
import type { NarrationEvent } from './watcher.js';

const log = childLogger('narrator');

// ── Session interface ─────────────────────────────────────────────────────

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
  injectTextWithKind?(text: string, kind: string, speak?: boolean): Promise<void>;
}

/**
 * Does a voice agent own spoken narration right now?
 *
 * Injected rather than imported so the narrator does not depend on the
 * executor, and so tests can drive both sides of the `auto` decision.
 */
export type NarrationOwnershipProbe = () => boolean;

// ── Narrator ──────────────────────────────────────────────────────────────

export class Narrator {
  private session: NarratorSession | null = null;
  private readonly buffer: NarrationEvent[] = [];
  private readonly maxBuffer: number;
  private ownershipProbe: NarrationOwnershipProbe = () => false;

  constructor(maxBuffer?: number) {
    this.maxBuffer = maxBuffer ?? getConfig().settings.narratorMaxBufferEvents;
  }

  /** Tell the narrator how to find out whether an agent is narrating. */
  setOwnershipProbe(probe: NarrationOwnershipProbe): void {
    this.ownershipProbe = probe;
  }

  /**
   * Attach (or detach) the active realtime session.
   * Call with null when the session closes; call with the new session when it
   * opens. On attach, buffered events are replayed as a digest.
   */
  async setSession(session: NarratorSession | null): Promise<void> {
    this.session = session;

    if (session && this.buffer.length > 0) {
      await this.replayBuffer();
    }
  }

  /** Everything buffered while nobody was listening, without draining it. */
  peekBuffer(): readonly NarrationEvent[] {
    return this.buffer;
  }

  /**
   * Receive a narration event from the Watcher.
   *
   * Note what is NOT here any more: an early `return` on a global narration
   * switch. The event always travels; only `speak` is gated.
   */
  async receive(event: NarrationEvent): Promise<void> {
    if (this.session?.isReady) {
      await this.inject(event);
    } else {
      this.bufferEvent(event);
    }
  }

  /** Whether this event's text should be played aloud right now. */
  private speakFlagFor(event: NarrationEvent): boolean {
    return shouldSpeakNarration(event.kind as CatalogKind, {
      agentOwnsNarration: this.ownershipProbe(),
    });
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async inject(event: NarrationEvent): Promise<void> {
    const session = this.session;
    if (!session?.isReady) {
      this.bufferEvent(event);
      return;
    }

    const speak = this.speakFlagFor(event);

    // Only defer for lines that will actually be heard — a silent event has no
    // reason to wait behind TTS.
    if (speak && session.isSpeaking) {
      log.debug({ kind: event.kind }, 'narrator: session speaking — deferring injection');
      await new Promise((res) => setTimeout(res, 1500));
      await this.inject(event); // Retry once
      return;
    }

    try {
      log.debug({ kind: event.kind, speak, text: event.text }, 'narrator: injecting');
      if (session.injectTextWithKind) {
        await session.injectTextWithKind(event.text, event.kind, speak);
      } else if (speak) {
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
   * Build the digest of what happened while nobody was listening.
   *
   * Split out from `replayBuffer` so the reconnect path in docs/36 can attach
   * the same text to the first `next_voice_turn()` and let the voice agent
   * tell it in its own words, rather than the bridge speaking over it.
   */
  buildDigest(): { text: string; files: number; commands: number; finished: boolean } | null {
    if (this.buffer.length === 0) return null;

    const doneEvent = [...this.buffer]
      .reverse()
      .find((e: NarrationEvent) => e.kind === 'job_done' || e.kind === 'job_error');
    const files = this.buffer.filter((e) => e.kind === 'file_write').length;
    // `shell_run` events are emitted now (silently) — before docs/39 this
    // count was structurally always zero.
    const commands = this.buffer.filter((e) => e.kind === 'shell_run').length;

    let text: string;
    if (doneEvent) {
      text = doneEvent.text;
      if (files > 0 || commands > 0) {
        text += ` ${phrase('away_replay', { files, commands })}`;
      }
    } else {
      text = phrase('away_progress', { agent: getActiveProvider().displayName, files });
    }

    return { text, files, commands, finished: Boolean(doneEvent) };
  }

  /** Drop everything buffered — the digest has been delivered another way. */
  clearBuffer(): void {
    this.buffer.length = 0;
  }

  /**
   * When a new session connects, replay buffered events as one digest rather
   * than a flood of individual messages.
   */
  private async replayBuffer(): Promise<void> {
    const digest = this.buildDigest();
    if (!digest) return;

    const session = this.session;
    if (!session?.isReady) return;

    this.clearBuffer();

    const speak = shouldSpeakNarration('away_replay', {
      agentOwnsNarration: this.ownershipProbe(),
    });

    try {
      if (session.injectTextWithKind) {
        await session.injectTextWithKind(digest.text, 'away_replay', speak);
      } else if (speak) {
        await session.injectText(digest.text);
      }
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

// ── PhoneRelaySession ─────────────────────────────────────────────────────
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
    recordNarration(text);
    await notifyPhone(narrationPayload({ kind: 'job_done', text, speak: true }));
  }

  async injectTextWithKind(text: string, kind: string, speak = true): Promise<void> {
    recordNarration(text);
    await notifyPhone(
      narrationPayload({ kind: kind as CatalogKind, text, speak }),
    );
  }
}
