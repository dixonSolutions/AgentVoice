/**
 * Voice I/O tool handlers for the AgentVoice MCP server.
 *
 * The voice agent calls these tools to interact with the user over voice:
 *   speak(text)         — push text to TTS, forward audio to PWA
 *   done()              — signal PWA to re-arm mic for next wake word
 *   next_voice_turn()   — long-poll dequeue of next user utterance
 *
 * The `speak` path mirrors the llm_intelligence `onSpeak` callback: it sends
 * { type: "speak", text } to all connected intelligence WebSocket clients.
 *
 * See docs/16-mcp-server-agent-as-brain.md.
 */

import { childLogger } from '../../log.js';
import { getConfig } from '../../config.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { voiceTurnQueue } from './turnQueue.js';
import { getActiveProvider } from '../../providers/agents/registry.js';

const log = childLogger('mcp:server:voiceTools');

voiceTurnQueue.setQueuedWithoutWaiterHandler((queueLen) => {
  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'user_turn',
    phase: 'start',
    label: 'User turn queued',
    detail: `${queueLen} pending — voice agent not in next_voice_turn()`,
  });
  log.info({ queueLen }, 'user turn queued while voice agent busy (not polling)');
});

voiceTurnQueue.setToolsInterruptedHandler((delivery, turn) => {
  // Dismiss any approval/question card the user has effectively answered by
  // speaking. `meta` is the ApprovalRequest the registry attached.
  for (const wait of delivery.aborted) {
    const request = wait.meta as { request_id?: string } | undefined;
    if (!request?.request_id) continue;
    void notifyPhone({
      type: 'approval_cancelled',
      request_id: request.request_id,
      reason: 'user_turn',
    });
  }

  const tools = [...delivery.aborted, ...delivery.annotated].map((w) => w.tool);
  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'user_turn',
    phase: 'start',
    label:
      delivery.aborted.length > 0
        ? 'User turn delivered — wait released'
        : 'User turn attached to running work',
    detail: turn.text.slice(0, 120),
  });
  log.info(
    { tools, aborted: delivery.aborted.length, annotated: delivery.annotated.length },
    'user turn delivered through in-flight AgentVoice tool(s)',
  );
});

/**
 * Tracks whether the current voice turn produced any speak() calls.
 * Used by the voice-agent exit fallback so mute agents still get TTS.
 *
 * Cleared when:
 *   - a new voice-agent process is spawned, or
 *   - next_voice_turn() delivers a real follow-up turn to the same process
 * NOT cleared when a follow-up is merely queued while the agent is mid-turn /
 * on done() — otherwise exit-fallback thinks the agent was silent and speaks
 * the agent’s internal assistant/planning text after a normal speak→done turn.
 */
let spokeThisTurn = false;

/** Reset at the start of a new agent-handled user turn. */
export function resetTurnSpeakTracking(): void {
  spokeThisTurn = false;
}

export function hadSpeakThisTurn(): boolean {
  return spokeThisTurn;
}

// ── Session broadcast registry ────────────────────────────────────────────
//
// Intelligence WebSocket connections register here so speak() can push audio.

type SendFn = (payload: unknown) => void;

const activeSessions = new Set<SendFn>();

export const NO_VOICE_SESSION_ERROR =
  'No active phone voice session — speak/done/next_voice_turn only work while the PWA voice session is live. Use normal text in the desktop IDE.';

export function hasActiveVoiceSession(): boolean {
  return activeSessions.size > 0;
}

export function getActiveVoiceSessionCount(): number {
  return activeSessions.size;
}

export function registerVoiceSession(send: SendFn): () => void {
  activeSessions.add(send);
  log.debug({ sessions: activeSessions.size }, 'voice session registered');
  return () => {
    activeSessions.delete(send);
    log.debug({ sessions: activeSessions.size }, 'voice session unregistered');
  };
}

export function broadcastToVoiceSessions(payload: unknown): void {
  for (const send of activeSessions) {
    try {
      send(payload);
    } catch (err) {
      log.warn({ err }, 'broadcast to session failed');
    }
  }
}

const turnCompleteHooks = new Set<() => void>();

/** Called when the agent invokes done() — clears server-side turn state. */
export function registerTurnCompleteHook(fn: () => void): () => void {
  turnCompleteHooks.add(fn);
  return () => {
    turnCompleteHooks.delete(fn);
  };
}

function notifyTurnComplete(): void {
  for (const fn of turnCompleteHooks) {
    try {
      fn();
    } catch (err) {
      log.warn({ err }, 'turn complete hook failed');
    }
  }
}

// ── Voice agent status broadcast ──────────────────────────────────────────

export interface VoiceAgentStatusPayload {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId?: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
}

/**
 * The coding agent behind this run, sent with every status broadcast.
 *
 * The PWA used to hardcode "Cursor agent starting…" in its session log, which
 * was simply wrong for Codex and Claude Code — and read as if AgentVoice were
 * announcing its own internals. Shipping the provider identity with the event
 * means the log always names the CLI that is actually running.
 */
function activeAgentIdentity(): { id: string; displayName: string } {
  const provider = getActiveProvider();
  return { id: provider.id, displayName: provider.displayName };
}

/** Push voice agent lifecycle to all connected PWA sessions (debug/monitor). */
export function broadcastVoiceAgentStatus(payload: VoiceAgentStatusPayload): void {
  log.info(
    {
      runId: payload.runId,
      pid: payload.pid,
      sessionId: payload.sessionId,
      mcpSessionId: payload.mcpSessionId,
      state: payload.state,
    },
    'voice agent status',
  );

  const agent = activeAgentIdentity();
  broadcastToVoiceSessions({
    type: 'voice_agent_status',
    run_id: payload.runId,
    pid: payload.pid,
    session_id: payload.sessionId,
    mcp_session_id: payload.mcpSessionId ?? null,
    state: payload.state,
    project: payload.project,
    provider: agent.id,
    provider_name: agent.displayName,
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────

export interface SpeakArgs {
  text: string;
  /** When false, plays TTS but does not count as the agent having spoken this turn. */
  countTowardTurn?: boolean;
}

export interface SpeakResult {
  ok: boolean;
  sessions: number;
  error?: string;
  message?: string;
}

/**
 * speak(text) — called by the voice agent to deliver a response to the user.
 * Broadcasts { type: "speak", text } to all connected PWA sessions.
 */
export function handleSpeak(args: SpeakArgs): SpeakResult {
  const text = (args.text ?? '').trim();
  if (!text) {
    return { ok: false, sessions: 0 };
  }
  if (!hasActiveVoiceSession()) {
    log.debug('speak rejected — no active PWA voice session');
    return { ok: false, sessions: 0, error: 'NO_VOICE_SESSION', message: NO_VOICE_SESSION_ERROR };
  }

  if (args.countTowardTurn !== false) {
    spokeThisTurn = true;
  }
  log.info({ text: text.slice(0, 80), sessions: activeSessions.size }, 'speak called');
  // eslint-disable-next-line no-console
  console.log(`[voice] ◀ speak: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`);
  broadcastToVoiceSessions({ type: 'speak', text });
  broadcastToVoiceSessions({ type: 'assistant_transcript', text });

  return { ok: true, sessions: activeSessions.size };
}

export interface DoneResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * done() — called by the voice agent when it has finished speaking.
 * Sends turn_complete; the PWA re-arms after queued TTS has finished.
 */
export function handleDone(): DoneResult {
  if (!hasActiveVoiceSession()) {
    return { ok: false, error: 'NO_VOICE_SESSION', message: NO_VOICE_SESSION_ERROR };
  }
  broadcastVoiceTurnIdle();
  return { ok: true };
}

/** Mark the turn complete — PWA waits for queued speech before re-arming. */
export function broadcastVoiceTurnIdle(): void {
  // Do not clear spokeThisTurn here — voiceAgent exit still needs it.
  log.info('voice turn complete — PWA will re-arm after queued speech');
  // eslint-disable-next-line no-console
  console.log('[voice] ✓ done — finishing queued speech before mic re-arms');
  broadcastToVoiceSessions({ type: 'thinking', value: false });
  broadcastToVoiceSessions({ type: 'turn_complete' });
  notifyTurnComplete();
}

export interface NextVoiceTurnArgs {
  /** Maximum milliseconds to wait for a turn (default 30 000, max 60 000). */
  timeout_ms?: number;
}

export interface NextVoiceTurnResult {
  /** The transcribed text, or null if timeout elapsed with no turn. */
  turn: string | null;
  /** Whether the turn should interrupt in-progress work. */
  is_interrupt: boolean;
  /** ISO timestamp the turn was received, or null on timeout. */
  received_at: string | null;
  /** Turns still buffered after this dequeue. */
  queue_depth: number;
  error?: string;
  message?: string;
  /**
   * When the user barged in during TTS: what they heard (especially last_heard_words),
   * plus lines cut off / not spoken. The agent keeps running — do not stop workers.
   */
  tts_interrupt?: {
    heard_complete: string[];
    heard_partial: string | null;
    not_spoken: string[];
    partial_words_estimate?: string | null;
    /** Last ~10 words the user heard aloud — treat as ground truth for continuity. */
    last_heard_words?: string;
  };
}

const MAX_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 30_000;

/**
 * next_voice_turn() — long-poll dequeue.
 * The voice agent calls this in a loop to receive the user's next utterance.
 * Returns immediately if a turn is already queued; otherwise suspends up to timeout_ms.
 */
export async function handleNextVoiceTurn(
  args: NextVoiceTurnArgs,
): Promise<NextVoiceTurnResult> {
  if (!hasActiveVoiceSession()) {
    return {
      turn: null,
      is_interrupt: false,
      received_at: null,
      queue_depth: 0,
      error: 'NO_VOICE_SESSION',
      message: NO_VOICE_SESSION_ERROR,
    };
  }

  const configuredDefault =
    getConfig().settings.voice.workerPollTimeoutMs ?? DEFAULT_POLL_MS;
  const timeoutMs = Math.min(
    args.timeout_ms != null && args.timeout_ms > 0 ? args.timeout_ms : configuredDefault,
    MAX_POLL_MS,
  );

  const turn = await voiceTurnQueue.dequeue(timeoutMs);

  if (!turn) {
    return { turn: null, is_interrupt: false, received_at: null, queue_depth: 0 };
  }

  // New utterance handed to this agent process — re-arm mute-exit fallback.
  resetTurnSpeakTracking();

  // Only signal thinking once a real user turn has arrived — not on every poll start.
  broadcastToVoiceSessions({ type: 'thinking', value: true });

  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'next_voice_turn',
    phase: 'done',
    label: 'Agent received turn',
    detail: turn.text.slice(0, 120),
  });

  return {
    turn: turn.text,
    is_interrupt: turn.isInterrupt,
    received_at: turn.receivedAt,
    queue_depth: voiceTurnQueue.size,
    ...(turn.ttsInterrupt ? { tts_interrupt: turn.ttsInterrupt } : {}),
  };
}
