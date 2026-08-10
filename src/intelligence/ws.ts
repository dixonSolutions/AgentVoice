/**
 * WebSocket handler for cascade voice workflows (/ws/intelligence).
 *
 * Supports:
 *   cursor_native   — STT → VoiceTurnQueue → Cursor MCP (speak/done)
 *   llm_intelligence — STT → Bedrock Claude orchestrator
 *
 * Phone → Bridge:
 *   { type: "auth", token }
 *   { type: "user_turn", text }     Final STT transcript
 *   { type: "speaking", value }     WebKit TTS state (narrator cadence)
 *
 * Bridge → Phone:
 *   { type: "auth_ok", sessionKey, workflow, wakeWords, turnSubmit, model }
 *   { type: "speak", text }         Pipe to WebKit TTS immediately
 *   { type: "thinking", value }     Orchestrator / Cursor busy
 *   { type: "turn_complete" }
 *   { type: "tool_activity", tool, phase, label?, detail? }
 *   { type: "session_log", subcategory, level, summary, detail?, at }
 *   { type: "error", message }
 */

import type { FastifyInstance } from 'fastify';
import { parseWsAuthMessage, verifyWsToken } from '../auth.js';
import { getConfig } from '../config.js';
import type { WorkflowId } from '../config.js';
import { childLogger } from '../log.js';
import { getNarrator, PhoneRelaySession } from '../executor/narrator.js';
import { isAmazonAudioAvailable } from './audio/awsClient.js';
import { createMemory, type ConversationMemory } from './memory.js';
import { runIntelligenceTurn as runOrchestratorTurn, type OrchestratorCallbacks } from './orchestrator.js';
import { voiceTurnQueue } from '../mcp/server/turnQueue.js';
import { parseTtsInterrupt } from '../voice/ttsInterrupt.js';
import {
  registerTurnCompleteHook,
  registerVoiceSession,
  handleSpeak,
  resetTurnSpeakTracking,
} from '../mcp/server/voiceToolHandlers.js';
import {
  spawnVoiceAgent,
  isVoiceAgentRunning,
  getActiveVoiceAgent,
  refreshProjectForVoice,
} from '../executor/voiceAgent.js';
import { resolveProject, getSessionState } from '../state/registry.js';

const log = childLogger('intelligence:ws');

interface IntelligenceSession {
  memory: ConversationMemory;
  sessionKey: string;
  workflow: WorkflowId;
  busy: boolean;
}

const sessions = new Map<object, IntelligenceSession>();

const WS_OPEN = 1;

function send(socket: { readyState: number; send: (data: string) => void }, payload: unknown): void {
  if (socket.readyState === WS_OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function formatIntelligenceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('on-demand throughput')) {
    return 'Bedrock model needs an inference profile ID. Set llm.model to us.anthropic.claude-sonnet-4-20250514-v1:0 in config.';
  }
  if (message.includes('AccessDeniedException') || message.includes('not authorized')) {
    return 'Bedrock access denied. Check AWS credentials and model access in the Bedrock console.';
  }
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function formatToolLabel(tool: string, phase: 'start' | 'done' | 'error'): string {
  if (phase === 'error') return `${tool} failed`;
  if (phase === 'done') return `${tool} done`;
  switch (tool) {
    case 'speak':
      return 'Speaking';
    case 'get_status':
    case 'cursor_status':
      return 'Checking Cursor progress';
    case 'launch_agent':
    case 'cursor_submit':
      return 'Sending task to Cursor';
    case 'read_output':
      return 'Reading Cursor output';
    case 'cursor_ask':
      return 'Asking Cursor';
    default:
      return tool.replace(/_/g, ' ');
  }
}

function isCascadeWorkflow(workflow: WorkflowId): boolean {
  return workflow === 'cursor_native' || workflow === 'llm_intelligence';
}

export function registerIntelligenceWebSocket(app: FastifyInstance): void {
  app.register(async (wsApp) => {
    wsApp.get('/ws/intelligence', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      const sessionKey = 'default';
      let relaySession: PhoneRelaySession | null = null;
      let intelSession: IntelligenceSession | null = null;
      let unregisterVoice: (() => void) | null = null;
      let unregisterTurnDone: (() => void) | null = null;

      log.debug({ sessionKey }, 'intelligence ws connection attempt');

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn({ sessionKey }, 'intelligence ws auth failed');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;

          relaySession = new PhoneRelaySession((data) => {
            if (socket.readyState === WS_OPEN) {
              socket.send(data);
            }
          });
          void getNarrator().setSession(relaySession);

          const { workflow, voice } = getConfig().settings;
          const workflowId = workflow.default;

          intelSession = {
            memory: createMemory(),
            sessionKey,
            workflow: workflowId,
            busy: false,
          };
          sessions.set(socket, intelSession);

          unregisterVoice = registerVoiceSession((payload) => send(socket, payload));
          unregisterTurnDone = registerTurnCompleteHook(() => {
            if (intelSession) intelSession.busy = false;
          });

          const { llm, audio } = workflow.llmIntelligence;
          const amazonAvailable = isAmazonAudioAvailable();

          send(socket, {
            type: 'auth_ok',
            sessionKey,
            workflow: workflowId,
            wakeWords: voice.wakeWords,
            turnSubmit: voice.turnSubmit,
            tts: voice.tts,
            model: workflowId === 'cursor_native' ? 'cursor' : llm.model,
            audio: {
              preferWebkit: audio.preferWebkit,
              ttsProvider: audio.ttsProvider,
              amazonAvailable,
              sttFallback: amazonAvailable ? 'amazon_transcribe' : null,
              ttsFallback: amazonAvailable ? 'amazon_polly' : null,
              pollyVoiceId: audio.pollyVoiceId,
              pollyEngine: audio.pollyEngine,
              transcribeLanguageCode: audio.transcribeLanguageCode,
            },
          });
          log.info({ sessionKey, workflow: workflowId }, 'intelligence ws authenticated');
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          send(socket, { type: 'error', message: 'Invalid JSON' });
          return;
        }

        if (msg['type'] === 'speaking' && typeof msg['value'] === 'boolean') {
          relaySession?.setSpeaking(msg['value']);
          return;
        }

        if (msg['type'] === 'user_turn') {
          const text = typeof msg['text'] === 'string' ? msg['text'].trim() : '';
          if (!text || !intelSession) return;

          log.info(
            { sessionKey, workflow: intelSession.workflow, textLen: text.length },
            'intelligence user_turn',
          );

          if (intelSession.busy && intelSession.workflow !== 'cursor_native') {
            send(socket, {
              type: 'speak',
              text: "One moment — I'm still working on your last request.",
            });
            return;
          }

          if (intelSession.workflow === 'cursor_native') {
            intelSession.busy = true;
            send(socket, { type: 'thinking', value: true });

            const ttsInterrupt = parseTtsInterrupt(msg['tts_interrupt']);
            const phraseInterrupt = /\b(stop everything|abort|quit)\b/i.test(text);
            const isInterrupt =
              Boolean(msg['is_interrupt']) && phraseInterrupt && !ttsInterrupt;

            const bridgeSession = getSessionState(sessionKey);
            let project = resolveProject(bridgeSession.activeProject ?? '');
            const agentAlreadyRunning = isVoiceAgentRunning();

            if (!agentAlreadyRunning) {
              if (!project) {
                send(socket, {
                  type: 'speak',
                  text: 'No project is selected. Choose a project in the voice tab first.',
                });
                send(socket, { type: 'thinking', value: false });
                send(socket, { type: 'turn_complete' });
                intelSession.busy = false;
                return;
              }

              // New agent process — reset speak tracking and drop orphaned queue
              // items from a previous run that never called next_voice_turn().
              resetTurnSpeakTracking();
              voiceTurnQueue.clear();

              project = refreshProjectForVoice(project);
              try {
                spawnVoiceAgent(project, bridgeSession, text);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err, sessionKey }, 'voice agent spawn failed');
                send(socket, { type: 'speak', text: `Could not start Cursor agent: ${message}` });
                send(socket, { type: 'error', message });
                send(socket, { type: 'thinking', value: false });
                send(socket, { type: 'turn_complete' });
                intelSession.busy = false;
                return;
              }
            } else {
              // Follow-up while the same agent is still alive: do NOT reset
              // spokeThisTurn. Clearing it made exit-fallback think the agent
              // never spoke and TTS Cursor's internal assistant/planning text.
              // Tracking resets when next_voice_turn() actually delivers a turn.
              voiceTurnQueue.enqueue(text, { isInterrupt, ttsInterrupt });
            }

            const va = getActiveVoiceAgent();

            log.info(
              {
                sessionKey,
                runId: va?.runId,
                pid: va?.pid,
                sessionId: va?.sessionId,
                delivery: agentAlreadyRunning ? 'queue' : 'spawn_prompt',
              },
              'cursor_native turn delivered',
            );
            return;
          }

          intelSession.busy = true;
          send(socket, { type: 'thinking', value: true });

          const callbacks: OrchestratorCallbacks = {
            onSpeak: (spoken) => {
              send(socket, { type: 'speak', text: spoken });
              send(socket, { type: 'assistant_transcript', text: spoken });
            },
            onThinking: (active) => send(socket, { type: 'thinking', value: active }),
            onToolActivity: (tool, phase, detail) => {
              send(socket, {
                type: 'tool_activity',
                tool,
                phase,
                label: formatToolLabel(tool, phase),
                detail,
              });
            },
          };

          void runOrchestratorTurn(intelSession.memory, text, sessionKey, callbacks)
            .catch((err: Error) => {
              log.error({ err, sessionKey }, 'intelligence turn failed');
              const message = formatIntelligenceError(err);
              send(socket, { type: 'speak', text: message });
              send(socket, { type: 'error', message });
            })
            .finally(() => {
              if (intelSession) intelSession.busy = false;
              send(socket, { type: 'thinking', value: false });
              send(socket, { type: 'turn_complete' });
            });
          return;
        }

        log.debug({ type: msg['type'] }, 'unhandled intelligence ws message');
      });

      socket.on('close', () => {
        sessions.delete(socket);
        unregisterVoice?.();
        unregisterTurnDone?.();
        unregisterVoice = null;
        unregisterTurnDone = null;
        // Do not kill the voice agent on WS close — user may reconnect; barge-in must not stop Cursor.
        if (relaySession) {
          void getNarrator().setSession(null);
          relaySession = null;
        }
        log.info({ sessionKey }, 'intelligence ws closed');
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionKey }, 'intelligence ws error');
      });
    });
  });
}

// Exported for tests / future routing guards.
export { isCascadeWorkflow };
