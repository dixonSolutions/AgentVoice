/**
 * Away policy — what the bridge does with running work when nobody is holding
 * the phone, and how it tells the agent.
 *
 * MCP is pull-only: the bridge cannot push "the user left" into a running CLI.
 * So the signal rides on AgentVoice tool results, exactly like the pending-turn
 * notice already does. Every agent-voice tool result carries a `listener`
 * block, and the voice tools answer differently while away instead of a bare
 * `NO_VOICE_SESSION` whose message told the agent to "use normal text" — which
 * in practice made it answer into a void and exit.
 *
 * This works identically for Cursor, Codex, Claude Code and Codewhale, because
 * it is carried by the MCP server every one of them registers, not by any
 * per-CLI mechanism.
 *
 * See docs/36-disconnect-and-background-work.md §3 and §4.
 */

import { getConfig, type AwayPolicy, type SessionSettings } from '../config.js';
import { getPresence, type ListenerState, type PresenceTracker } from './presence.js';
import { childLogger } from '../log.js';

const log = childLogger('away-policy');

export type { AwayPolicy };

export interface ListenerBlock {
  state: ListenerState;
  /** ISO timestamp the listener went away, or null while connected. */
  away_since: string | null;
  away_ms: number;
  policy: AwayPolicy;
  /** What the agent should do about it, in words the agent can act on. */
  instructions: string;
  /** True when a desk client is watching even though no phone is. */
  desk_watching: boolean;
}

const INSTRUCTIONS: Record<AwayPolicy, string> = {
  keep_working:
    'The user is away. Keep working autonomously: finish the task, do not ask ' +
    'questions you can answer yourself, and do not exit early. speak() still ' +
    'records what you say for the catch-up summary they will hear on return.',
  finish_turn:
    'The user is away. Finish the step you are on, summarise it with speak() ' +
    'for the catch-up summary, then stop — do not start new work.',
  stop_all:
    'The user is away and asked for everything to stop. Reach a safe point now: ' +
    'do not start anything new, leave the working tree consistent, and finish.',
};

const CONNECTED_INSTRUCTIONS =
  'The user is listening. Speak before and after each phase, and end the turn with done().';

const GRACE_INSTRUCTIONS =
  'The user dropped off a second ago and may be straight back — this is usually a ' +
  'network blip. Carry on exactly as if they were listening.';

/**
 * Where the policy reads its inputs from.
 *
 * Both are indirected rather than imported at each call site so the decision
 * logic can be exercised against a fixture: nothing here needs a config file
 * on disk or a live WebSocket to be worth testing.
 */
export interface AwayPolicyDeps {
  sessionSettings: () => SessionSettings;
  presence: () => PresenceTracker;
}

const liveDeps: AwayPolicyDeps = {
  sessionSettings: () => getConfig().settings.session,
  presence: () => getPresence(),
};

let deps: AwayPolicyDeps = liveDeps;

/** Swap the inputs. Used by tests; the bridge never calls this. */
export function useAwayPolicyDeps(next: Partial<AwayPolicyDeps>): void {
  deps = { ...liveDeps, ...next };
}

/** The configured policy, including any per-conversation override. */
let conversationOverride: AwayPolicy | null = null;

/**
 * Per-conversation override, set by voice ("keep going while I'm away").
 * Cleared when a new voice agent run starts, so it never leaks into the next
 * conversation.
 */
export function setConversationAwayPolicy(policy: AwayPolicy | null): void {
  conversationOverride = policy;
  log.info({ policy }, 'conversation away policy override');
}

export function getConversationAwayPolicy(): AwayPolicy | null {
  return conversationOverride;
}

export function effectiveAwayPolicy(): AwayPolicy {
  return conversationOverride ?? deps.sessionSettings().onPhoneAway;
}

/** The `listener` block attached to every agent-voice tool result. */
export function listenerBlock(): ListenerBlock {
  const snapshot = deps.presence().snapshot();
  const policy = effectiveAwayPolicy();
  let instructions: string;
  switch (snapshot.state) {
    case 'connected':
      instructions = CONNECTED_INSTRUCTIONS;
      break;
    case 'grace':
      instructions = GRACE_INSTRUCTIONS;
      break;
    default:
      instructions = INSTRUCTIONS[policy];
  }
  return {
    state: snapshot.state,
    away_since: snapshot.awaySince === null ? null : new Date(snapshot.awaySince).toISOString(),
    away_ms: snapshot.awayMs,
    policy,
    instructions,
    desk_watching: snapshot.deskPresent,
  };
}

/** Attach the listener block to any tool result object, in place. */
export function withListener<T extends object>(result: T): T & { listener: ListenerBlock } {
  return Object.assign(result, { listener: listenerBlock() });
}

/** True while the user can still hear us (connected, or inside grace). */
export function isListening(): boolean {
  return deps.presence().isListening();
}

/**
 * Minimum wait the bridge enforces on `next_voice_turn` while away.
 *
 * Without it an agent told "no turn available" loops immediately and burns the
 * user's tokens at full speed for as long as they are gone. The floor is a
 * server-side promise, not advice in a message.
 */
export const AWAY_POLL_FLOOR_MS = 20_000;

export async function awayPollDelay(requestedMs: number): Promise<void> {
  const wait = Math.max(AWAY_POLL_FLOOR_MS, Math.min(requestedMs, 60_000));
  await new Promise((resolve) => setTimeout(resolve, wait));
}

// ── Unattended budgets ──────────────────────────────────────────────────────

interface AwayBudget {
  startedAt: number;
  toolCalls: number;
}

let budget: AwayBudget | null = null;

/** Start (or restart) the away budget. Called on the connected → away edge. */
export function beginAwayPeriod(now = Date.now()): void {
  budget = { startedAt: now, toolCalls: 0 };
  log.info('away budget started');
}

/** The user is back — the budget no longer applies. */
export function endAwayPeriod(): void {
  budget = null;
}

export interface BudgetVerdict {
  exceeded: boolean;
  reason: 'runtime' | 'tool_calls' | null;
  message: string | null;
}

const OK: BudgetVerdict = { exceeded: false, reason: null, message: null };

/**
 * Count one agent-voice tool call against the away budget and report whether
 * the budget is spent. Attended work is never counted.
 */
export function chargeAwayBudget(now = Date.now()): BudgetVerdict {
  if (!budget) return OK;
  const { unattended } = deps.sessionSettings();
  budget.toolCalls++;

  const elapsed = now - budget.startedAt;
  if (elapsed > unattended.maxRuntimeMs) {
    return {
      exceeded: true,
      reason: 'runtime',
      message:
        `The unattended budget of ${Math.round(unattended.maxRuntimeMs / 60_000)} minutes is spent. ` +
        'Stop at a safe point and summarise what you did — the user will hear it when they return.',
    };
  }
  if (unattended.maxToolCalls > 0 && budget.toolCalls > unattended.maxToolCalls) {
    return {
      exceeded: true,
      reason: 'tool_calls',
      message:
        `The unattended tool-call budget of ${unattended.maxToolCalls} is spent. ` +
        'Stop at a safe point and summarise what you did.',
    };
  }
  return OK;
}

export function awayBudgetSnapshot(): { active: boolean; elapsedMs: number; toolCalls: number } {
  if (!budget) return { active: false, elapsedMs: 0, toolCalls: 0 };
  return {
    active: true,
    elapsedMs: Date.now() - budget.startedAt,
    toolCalls: budget.toolCalls,
  };
}

// ── Approval and secret handling while away ─────────────────────────────────

export interface AwayApprovalDecision {
  /** 'ask' keeps the card open; the others answer it without the user. */
  action: 'ask' | 'deny' | 'skip';
  /** Milliseconds the card stays open when action is 'ask'. */
  timeoutMs: number;
  /** What to tell the agent when the card is answered for them. */
  message: string | null;
}

/**
 * How an approval card behaves right now.
 *
 * While the user is listening this is always "ask" with the caller's own
 * timeout. While they are away it follows `session.unattended.approvals`.
 */
export function approvalPolicy(defaultTimeoutMs: number): AwayApprovalDecision {
  if (isListening()) {
    return { action: 'ask', timeoutMs: defaultTimeoutMs, message: null };
  }
  const { unattended } = deps.sessionSettings();
  switch (unattended.approvals) {
    case 'deny':
      return {
        action: 'deny',
        timeoutMs: defaultTimeoutMs,
        message:
          'The user is away and has asked not to be interrupted for approvals. ' +
          'Treat this as a no and pick another approach.',
      };
    case 'skip':
      return {
        action: 'skip',
        timeoutMs: defaultTimeoutMs,
        message:
          'The user is away. This step is declined for now — skip it and carry on ' +
          'with the parts of the task that do not need it.',
      };
    case 'wait_push':
    default:
      // Keep the card open far longer than the attended default: the point of
      // wait_push is that the user answers it from a notification, minutes later.
      return {
        action: 'ask',
        timeoutMs: Math.max(defaultTimeoutMs, unattended.approvalTimeoutMs),
        message: null,
      };
  }
}

/**
 * Whether an askpass prompt should even be shown while away.
 *
 * `fail_fast` is the default because a `sudo` prompt that nobody will answer
 * otherwise blocks the agent's shell for the full approval timeout — a
 * quarter of an hour of a job doing nothing.
 */
export function askpassPolicy(): { ask: boolean; timeoutMs: number; reason: string | null } {
  const { unattended } = deps.sessionSettings();
  if (isListening()) return { ask: true, timeoutMs: 300_000, reason: null };
  if (unattended.secrets === 'fail_fast') {
    return {
      ask: false,
      timeoutMs: 0,
      reason: 'the user is away and secret prompts are set to fail fast',
    };
  }
  return { ask: true, timeoutMs: unattended.approvalTimeoutMs, reason: null };
}

// ── Wiring ──────────────────────────────────────────────────────────────────

let wired = false;

/**
 * Start / stop the away budget from presence transitions. Idempotent so the
 * server can call it on every boot path.
 */
export function wireAwayPolicy(): void {
  if (wired) return;
  wired = true;
  deps.presence().onChange((snapshot, previous) => {
    if (snapshot.state === 'connected') {
      endAwayPeriod();
    } else if (previous === 'connected') {
      beginAwayPeriod();
    }
  });
  deps.presence().setGraceMs(deps.sessionSettings().graceMs);
}

/** Test hook — drop the module's process-wide state. */
export function resetAwayPolicyForTests(): void {
  conversationOverride = null;
  budget = null;
  wired = false;
}

/** Put the live config and presence singleton back. */
export function useLiveAwayPolicyDeps(): void {
  deps = liveDeps;
}
