/**
 * One entry point for a user turn in the `agent_native` workflow, whichever
 * surface it came from: the phone (`/ws/intelligence` after STT), the desk
 * socket (`/ws/events`), or `POST /api/turns` (typed in the IDE).
 *
 * Spawn-or-queue, exactly as the phone path always did:
 *   - no voice agent running → spawn the active CLI with the turn as its
 *     opening request (needs an active project);
 *   - agent alive → enqueue; the turn reaches it through next_voice_turn() or
 *     the interrupt hook (mcp/server/pendingWaits.ts).
 *
 * Nothing here is CLI-specific: the provider builds the argv in spawnVoiceAgent.
 */

import { getActiveProvider } from '../providers/agents/registry.js';
import { voiceTurnQueue, type EnqueueDelivery } from '../mcp/server/turnQueue.js';
import { resetTurnSpeakTracking } from '../mcp/server/voiceToolHandlers.js';
import type { TtsInterruptContext } from '../voice/ttsInterrupt.js';
import { getSessionState, resolveProject } from '../state/registry.js';
import { publishEvent } from '../state/eventBus.js';
import { childLogger } from '../log.js';
import {
  getActiveVoiceAgent,
  isVoiceAgentRunning,
  refreshProjectForVoice,
  registerVoiceAgentExitHook,
  spawnVoiceAgent,
} from './voiceAgent.js';

const log = childLogger('agent-turns');

export type TurnSource = 'phone' | 'desk' | 'rest' | string;

export interface SubmitTurnOptions {
  /** Session key the turn belongs to — voice and desk share 'default'. */
  sessionKey?: string;
  source: TurnSource;
  isInterrupt?: boolean;
  ttsInterrupt?: TtsInterruptContext;
}

export interface TurnDelivery {
  /** `spawn` = a new agent process opened with this turn; otherwise how the queue delivered it. */
  delivery: 'spawn' | EnqueueDelivery['kind'];
  project: string;
  run_id: string | null;
  pid: number | null;
  session_id: string | null;
}

export class TurnError extends Error {
  constructor(
    public readonly code: 'EMPTY' | 'NO_PROJECT' | 'SPAWN_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'TurnError';
  }
}

export function submitAgentNativeTurn(rawText: string, opts: SubmitTurnOptions): TurnDelivery {
  const text = rawText.trim();
  if (!text) throw new TurnError('EMPTY', 'Turn text is empty.');
  const sessionKey = opts.sessionKey ?? 'default';

  const bridgeSession = getSessionState(sessionKey);
  let project = resolveProject(bridgeSession.activeProject ?? '');
  const alreadyRunning = isVoiceAgentRunning();
  let delivery: TurnDelivery['delivery'];

  if (!alreadyRunning) {
    if (!project) {
      throw new TurnError('NO_PROJECT', 'No project is selected. Choose a project first.');
    }
    // New agent process — reset speak tracking and drop orphaned queue items
    // from a previous run that never called next_voice_turn().
    resetTurnSpeakTracking();
    voiceTurnQueue.clear();
    project = refreshProjectForVoice(project);
    try {
      spawnVoiceAgent(project, bridgeSession, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionKey, source: opts.source }, 'voice agent spawn failed');
      throw new TurnError(
        'SPAWN_FAILED',
        `Could not start ${getActiveProvider().displayName}: ${message}`,
      );
    }
    delivery = 'spawn';
  } else {
    // Follow-up while the same agent is still alive: do NOT reset spokeThisTurn
    // (see intelligence/ws.ts history) — tracking resets when next_voice_turn()
    // actually delivers the turn.
    const result = voiceTurnQueue.enqueue(text, {
      isInterrupt: opts.isInterrupt,
      ttsInterrupt: opts.ttsInterrupt,
    });
    delivery = result.kind;
  }

  const va = getActiveVoiceAgent();
  const out: TurnDelivery = {
    delivery,
    project: va?.project ?? project?.name ?? '',
    run_id: va?.runId ?? null,
    pid: va?.pid ?? null,
    session_id: va?.sessionId ?? null,
  };

  log.info(
    { sessionKey, source: opts.source, runId: out.run_id, pid: out.pid, delivery, textLen: text.length },
    'agent_native turn delivered',
  );
  // Every desk client sees every turn, whichever surface typed or spoke it.
  publishEvent({ type: 'user_turn', text, source: opts.source, delivery, run_id: out.run_id });
  return out;
}

// ── Orphaned turns ───────────────────────────────────────────────────────────
//
// A turn that arrives while the agent process is already on its way out (it
// called done() and then finished instead of polling next_voice_turn()) lands
// in the queue and would sit there until the next turn — which then *clears*
// the queue before spawning. Live-tested on Claude Code from the desk: the
// second typed turn simply vanished. So when a voice agent exits cleanly with
// turns still queued, respawn immediately with them as the opening request;
// the project's resume id keeps it the same conversation.

async function drainQueuedTurns(): Promise<string[]> {
  const texts: string[] = [];
  while (voiceTurnQueue.size > 0) {
    const turn = await voiceTurnQueue.dequeue(1);
    if (!turn) break;
    texts.push(turn.text);
  }
  return texts;
}

registerVoiceAgentExitHook((info) => {
  if (info.stopped || info.exitCode !== 0 || voiceTurnQueue.size === 0) return;
  void drainQueuedTurns().then((texts) => {
    if (texts.length === 0 || isVoiceAgentRunning()) return;
    const text = texts.join('\n\n');
    log.info({ runId: info.runId, turns: texts.length }, 'voice agent exited with turns queued — respawning');
    try {
      submitAgentNativeTurn(text, { source: 'requeue' });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'respawn with queued turn failed');
      publishEvent({ type: 'error', code: 'RESPAWN_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });
});
