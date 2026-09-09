/**
 * `/ws/events` — the multi-client desk socket (VS Code / Cursor extension,
 * docs/34-vscode-extension.md).
 *
 * Why a third socket: `/ws/control` and `/ws/intelligence` each register a
 * single narrator / approval target, so a second connection would silently
 * displace the phone. This one is observe-and-submit only:
 *
 *   Bridge → client
 *     { type: "auth_ok", ...snapshot }          state at connect (pending approvals, project, agent)
 *     everything broadcastToVoiceSessions sends  speak, assistant_transcript, thinking,
 *                                                 turn_complete, tool_activity, voice_agent_status
 *     everything notifyPhone sends              *_request, approval_cancelled, narration, show_images, …
 *     { type: "agent_event", source, event }    normalized CLI stream events (voice agent + workers)
 *     { type: "user_turn", text, source }       a turn submitted from any surface
 *
 *   Client → bridge
 *     { type: "auth", token }
 *     { type: "user_turn", text }               spawn-or-queue, same as the phone
 *     { type: "approval_response", request_id, response }
 *     { type: "ping" }
 *
 * Registering as a voice session means speak()/done() succeed when only the
 * desk is connected — the agent's spoken lines land in the editor panel.
 */

import type { FastifyInstance } from 'fastify';
import { parseWsAuthMessage, verifyWsToken } from '../auth.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { registerVoiceSession } from '../mcp/server/voiceToolHandlers.js';
import { getPendingApprovals } from '../mcp/server/approvalRegistry.js';
import { applyApprovalResponse } from '../mcp/server/approvalResponses.js';
import { voiceTurnQueue } from '../mcp/server/turnQueue.js';
import { subscribeEvents } from '../state/eventBus.js';
import { getSessionState, resolveProject } from '../state/registry.js';
import { getActiveVoiceAgent } from '../executor/voiceAgent.js';
import { submitAgentNativeTurn, TurnError } from '../executor/agentTurns.js';
import { getAllActiveJobSummaries } from '../executor/jobManager.js';
import { describePermissionModes } from '../providers/agents/permissions.js';

const log = childLogger('ws:events');
const WS_OPEN = 1;

/** Snapshot a desk client needs to render its status line without extra calls. */
export function deskStateSnapshot(): Record<string, unknown> {
  const { settings } = getConfig();
  const provider = getActiveProvider();
  const session = getSessionState('default');
  const va = getActiveVoiceAgent();
  return {
    provider: { id: provider.id, displayName: provider.displayName },
    workflow: settings.workflow.default,
    // A stale name (e.g. an ephemeral workspace project disabled by a bridge
    // restart) must read as "none" so the desk client re-registers its folder.
    activeProject: resolveProject(session.activeProject ?? '')?.name ?? null,
    activeModel: session.activeModel,
    activeEffort: session.activeEffort,
    activeFast: session.activeFast,
    permissionMode: describePermissionModes().active,
    pending: getPendingApprovals(),
    voice_agent: va
      ? { run_id: va.runId, pid: va.pid, session_id: va.sessionId, project: va.project, state: 'running' }
      : null,
    listening: voiceTurnQueue.waitersCount > 0,
    pending_user_turns: voiceTurnQueue.size,
    jobs: getAllActiveJobSummaries(),
  };
}

export function registerEventsSocket(app: FastifyInstance): void {
  app.register(async (wsApp) => {
    wsApp.get('/ws/events', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      let unregisterVoice: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;

      const send = (payload: unknown): void => {
        if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(payload));
      };

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn('events ws auth failed — closing');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;
          unregisterVoice = registerVoiceSession(send);
          unsubscribe = subscribeEvents(send);
          send({ type: 'auth_ok', sessionKey: 'default', client: 'events', ...deskStateSnapshot() });
          log.info('events ws authenticated');
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          send({ type: 'error', message: 'Invalid JSON' });
          return;
        }

        switch (msg['type']) {
          case 'ping':
            send({ type: 'pong', ...deskStateSnapshot() });
            return;

          case 'speaking':
            // Desk TTS state is local to the editor; the narrator only follows the phone.
            return;

          case 'user_turn': {
            const text = typeof msg['text'] === 'string' ? msg['text'] : '';
            const workflow = getConfig().settings.workflow.default;
            if (workflow !== 'agent_native') {
              send({ type: 'error', code: 'WORKFLOW', message: `Desk turns need the agent_native workflow (active: ${workflow}).` });
              return;
            }
            try {
              const delivery = submitAgentNativeTurn(text, { source: 'desk', isInterrupt: msg['is_interrupt'] === true });
              send({ type: 'turn_accepted', ...delivery });
            } catch (err) {
              const code = err instanceof TurnError ? err.code : 'ERROR';
              const message = err instanceof Error ? err.message : String(err);
              send({ type: 'error', code, message });
              send({ type: 'turn_complete' });
            }
            return;
          }

          case 'approval_response': {
            const request_id = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
            if (!request_id) {
              send({ type: 'approval_ack', request_id: null, ok: false, reason: 'invalid' });
              return;
            }
            const result = applyApprovalResponse(request_id, msg['response'], 'desk');
            send({ type: 'approval_ack', request_id, ...result });
            return;
          }

          default:
            log.debug({ type: msg['type'] }, 'unhandled events ws message');
        }
      });

      socket.on('close', () => {
        unregisterVoice?.();
        unsubscribe?.();
        unregisterVoice = null;
        unsubscribe = null;
        log.info('events ws closed');
      });

      socket.on('error', (err: Error) => {
        log.error({ err }, 'events ws error');
      });
    });
  });
}
