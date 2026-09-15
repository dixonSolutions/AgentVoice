/**
 * `agent_busy` — one authoritative account of what is running, pushed to the
 * phone so the orb can show it (docs/40 §3, #65).
 *
 * `VoiceSessionService._jobRunning` and the app's `working` state already
 * existed, but they were *inferred*: set from narration kinds, from tool
 * activity, and from an `onWorking` callback. That inference is wrong in three
 * situations the user actually hits — narration turned off, a reconnect after
 * the phone was away, and a worker that finished while the app was closed.
 *
 * So the bridge states it directly, and re-states it whenever it changes or a
 * client reconnects.
 */

import { childLogger } from '../log.js';
import { notifyPhone } from '../push/notifyPhone.js';
import { getAllActiveRuns } from '../executor/agentSingleton.js';
import { isVoiceAgentRunning } from '../executor/voiceAgent.js';
import { getPendingApprovals } from '../mcp/server/approvalRegistry.js';

const log = childLogger('agent-busy');

export interface AgentBusyState {
  /** A user turn has been received and `done()` has not been called yet. */
  voiceTurnActive: boolean;
  /** Running workers — the singleton plus the worktree pool. */
  workers: number;
  /** Approval / question cards the user has not answered. */
  pendingApprovals: number;
}

let voiceTurnActive = false;
let lastSent: string | null = null;

/** A user turn has started — the agent owes the user an answer. */
export function markVoiceTurnStarted(): void {
  voiceTurnActive = true;
  publishAgentBusy();
}

/** `done()` — the turn is closed. */
export function markVoiceTurnFinished(): void {
  voiceTurnActive = false;
  publishAgentBusy();
}

export function agentBusyState(): AgentBusyState {
  return {
    voiceTurnActive: voiceTurnActive && isVoiceAgentRunning(),
    workers: getAllActiveRuns().length,
    pendingApprovals: getPendingApprovals().length,
  };
}

/**
 * Push the current state, skipping a push that would say nothing new.
 *
 * `force` is for reconnects: the client's copy is gone even though the state
 * has not changed, so the dedupe must not swallow it.
 */
export function publishAgentBusy(force = false): void {
  const state = agentBusyState();
  const key = `${state.voiceTurnActive}:${state.workers}:${state.pendingApprovals}`;
  if (!force && key === lastSent) return;
  lastSent = key;
  log.debug(state, 'agent_busy');
  void notifyPhone({
    type: 'agent_busy',
    voice_turn_active: state.voiceTurnActive,
    workers: state.workers,
    pending_approvals: state.pendingApprovals,
  });
}

/** Test hook. */
export function resetAgentBusy(): void {
  voiceTurnActive = false;
  lastSent = null;
}
