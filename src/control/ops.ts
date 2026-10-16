/**
 * The control commands' view of the real bridge (types.ts `BridgeOps`).
 *
 * Reads go straight to the state modules. Settings changes go through the
 * bridge's own admin API in-process (`app.inject`), so a change made from the
 * CLI or a chat is validated and has the same side effects as the Config
 * screen — switching the agent CLI resets a model it does not have, a speech
 * provider change re-routes the chain, and so on. Nothing per-CLI is listed
 * here: permission modes and models come from the active provider (docs/24,
 * docs/33).
 */

import type { FastifyInstance } from 'fastify';
import { AGENT_CLIENTS, getConfig, VOICE_INPUT_MODES, WORKFLOW_IDS } from '../config.js';
import { AWAY_POLICIES, SPEECH_INPUT_PROVIDERS, SPEECH_OUTPUT_PROVIDERS } from '../config.js';
import { getActiveVoiceAgent, killVoiceAgent } from '../executor/voiceAgent.js';
import { handleNewSession } from '../mcp/tools/session.js';
import { describePermissionModes } from '../providers/agents/permissions.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { getSpeechInputSpecializer } from '../providers/speech/input/orchestrator.js';
import { primaryServerSpeechInputId } from '../providers/speech/input/service.js';
import { getSpeechOutputSpecializer } from '../providers/speech/output/orchestrator.js';
import { primaryServerSpeechOutputId } from '../providers/speech/output/service.js';
import { listenerState } from '../state/presence.js';
import {
  getSessionState,
  listProjects,
  resolveProject,
  setActiveProject,
  setProjectResumeId,
} from '../state/registry.js';
import { getDb } from '../state/db.js';
import { listCursorSessionsForProject } from '../state/jobs.js';
import { listSessions, spokenName } from '../state/sessionDirectory.js';
import type { BridgeOps, ConfigKeyInfo, SessionRow } from './types.js';

/** In-process call to the bridge's own HTTP API (Fastify `inject`), already authenticated. */
export type BridgeApi = (method: 'GET' | 'PATCH' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** A BridgeApi over this Fastify instance, authenticated with the bridge's own token. */
export function injectApi(app: FastifyInstance): BridgeApi {
  return async (method, url, body) => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${getConfig().env.APP_TOKEN}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let parsed: unknown = null;
    try {
      parsed = res.json();
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed };
  };
}

interface ConfigKey extends ConfigKeyInfo {
  get(): string;
  set(value: string, api: BridgeApi): Promise<string>;
}

function errorOf(res: { status: number; body: unknown }): string {
  const body = res.body as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `HTTP ${res.status}`;
}

async function call(api: BridgeApi, method: 'PATCH' | 'POST', url: string, body: unknown): Promise<void> {
  const res = await api(method, url, body);
  if (res.status >= 400) throw new Error(errorOf(res));
}

function oneOf(value: string, choices: readonly string[], key: string): string {
  const v = value.trim().toLowerCase();
  const match = choices.find((c) => c.toLowerCase() === v);
  if (!match) throw new Error(`\`${key}\` must be one of: ${choices.join(', ')}`);
  return match;
}

function configKeys(): ConfigKey[] {
  const s = () => getConfig().settings;
  const audio = () => s().workflow.llmIntelligence.audio;
  const permissionModes = describePermissionModes();
  return [
    {
      key: 'agent',
      help: 'agent CLI the voice agent runs',
      choices: AGENT_CLIENTS,
      get: () => s().agentClient,
      async set(v, api) {
        await call(api, 'PATCH', '/api/admin/agent-client', { client: oneOf(v, AGENT_CLIENTS, 'agent') });
        return `Agent CLI is now **${getActiveProvider().displayName}**.`;
      },
    },
    {
      key: 'model',
      help: `model for ${getActiveProvider().displayName} (\`auto\` lets it choose)`,
      get: () => s().defaultActiveModel,
      async set(v, api) {
        await call(api, 'POST', '/api/providers/model', { model_id: v.trim(), scope: 'global' });
        return `Model is now **${s().defaultActiveModel}**.`;
      },
    },
    {
      key: 'permissions',
      help: `what ${permissionModes.displayName} may do without asking`,
      choices: permissionModes.modes.map((m) => m.id),
      get: () => describePermissionModes().active.id,
      async set(v, api) {
        await call(api, 'POST', '/api/providers/permission-mode', { mode: v.trim() });
        return `Permission mode is now **${describePermissionModes().active.label}**.`;
      },
    },
    {
      key: 'workflow',
      help: 'voice pipeline',
      choices: WORKFLOW_IDS,
      get: () => s().workflow.default,
      async set(v, api) {
        await call(api, 'PATCH', '/api/admin/workflow', { default: oneOf(v, WORKFLOW_IDS, 'workflow') });
        return `Workflow is now **${s().workflow.default}**.`;
      },
    },
    {
      key: 'input',
      help: 'how the phone listens',
      choices: VOICE_INPUT_MODES,
      get: () => s().voice.inputMode,
      async set(v, api) {
        await call(api, 'PATCH', '/api/voice/input', { inputMode: oneOf(v, VOICE_INPUT_MODES, 'input') });
        return `Input mode is now **${s().voice.inputMode}**.`;
      },
    },
    {
      key: 'stt',
      help: 'speech-to-text provider',
      choices: SPEECH_INPUT_PROVIDERS,
      get: () => audio().stt.provider,
      async set(v, api) {
        await call(api, 'PATCH', '/api/speech/stt', { provider: oneOf(v, SPEECH_INPUT_PROVIDERS, 'stt') });
        return `Speech-to-text is now **${audio().stt.provider}**.`;
      },
    },
    {
      key: 'tts',
      help: 'voice the agent speaks with',
      choices: SPEECH_OUTPUT_PROVIDERS,
      get: () => audio().tts.provider,
      async set(v, api) {
        await call(api, 'PATCH', '/api/speech/tts', { provider: oneOf(v, SPEECH_OUTPUT_PROVIDERS, 'tts') });
        return `Voice is now **${audio().tts.provider}**.`;
      },
    },
    // The voice session's own settings (the Voice tab) — a phone and a call
    // listen by the same ones.
    {
      key: 'wake',
      help: `wake words: speech is a request only after "${s().voice.wakeWords.start}" (turns input)`,
      choices: ['on', 'off'],
      get: () => (s().voice.wakeWordsEnabled !== false ? 'on' : 'off'),
      async set(v, api) {
        const on = oneOf(v, ['on', 'off'], 'wake') === 'on';
        await call(api, 'PATCH', '/api/voice/ui', { wakeWordsEnabled: on });
        return `Wake words are **${on ? 'on' : 'off'}**${on ? ` — say "${s().voice.wakeWords.start}" before a request` : ''}. Applies to the next voice session or call.`;
      },
    },
    {
      key: 'vad',
      help: `a pause ends a request (off: say "${s().voice.wakeWords.end}")`,
      choices: ['on', 'off'],
      get: () => (s().voice.turnSubmit.vadEnabled !== false ? 'on' : 'off'),
      async set(v, api) {
        const on = oneOf(v, ['on', 'off'], 'vad') === 'on';
        await call(api, 'PATCH', '/api/voice/wake-words', { start: s().voice.wakeWords.start, vadEnabled: on });
        return on ? 'VAD is **on** — a pause ends a request.' : `VAD is **off** — "${s().voice.wakeWords.end}" ends a request.`;
      },
    },
    {
      key: 'silence',
      help: 'ms of quiet that ends a request (500–30000)',
      get: () => String(s().voice.turnSubmit.silenceMs),
      async set(v, api) {
        const ms = Number(v.trim());
        if (!Number.isInteger(ms) || ms < 500 || ms > 30_000) throw new Error('`silence` is a whole number of ms, 500–30000');
        await call(api, 'PATCH', '/api/voice/wake-words', { start: s().voice.wakeWords.start, silenceMs: ms });
        return `A request ends after **${s().voice.turnSubmit.silenceMs} ms** of quiet.`;
      },
    },
    ...(['start', 'end', 'cancel'] as const).map(
      (which): ConfigKey => ({
        key: `${which}phrase`,
        help: which === 'start' ? 'wake phrase that starts a request' : which === 'end' ? 'phrase that sends a request (VAD off)' : 'phrase that drops a request',
        get: () => s().voice.wakeWords[which] ?? '',
        async set(v, api) {
          const w = s().voice.wakeWords;
          await call(api, 'PATCH', '/api/voice/wake-words', { ...{ start: w.start, end: w.end, cancel: w.cancel }, [which]: v.trim() });
          return `The ${which} phrase is now **${s().voice.wakeWords[which]}**.`;
        },
      }),
    ),
    {
      key: 'away',
      help: 'what running work does when nobody is listening',
      choices: AWAY_POLICIES,
      get: () => s().session.onPhoneAway,
      async set(v, api) {
        await call(api, 'PATCH', '/api/admin/session', { onPhoneAway: oneOf(v, AWAY_POLICIES, 'away') });
        return `When nobody is listening: **${s().session.onPhoneAway}**.`;
      },
    },
  ];
}

/**
 * Sessions the bridge itself ran (voice agent and worker history — what the
 * phone's session picker lists), for any the CLI's own store did not show.
 * Voice runs store no prompt, so they are named after their first spoken turn.
 */
function bridgeHistory(project: string | undefined, seen: Set<string>): SessionRow[] {
  const projects = listProjects().filter((p) => p.enabled && (!project || p.name === project));
  const firstTurn = getDb().prepare(
    `SELECT text FROM turn WHERE project = ? AND session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`,
  );
  const out: SessionRow[] = [];
  for (const p of projects) {
    for (const h of listCursorSessionsForProject(p.name, 15)) {
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      const prompt = h.lastPrompt || (firstTurn.get(p.name, h.sessionId) as { text?: string } | undefined)?.text || '';
      out.push({
        handle: `history:${h.sessionId}`,
        name: spokenName({ prompt, kind: 'recent', index: out.length }),
        kind: 'recent',
        project: p.name,
        providerName: getActiveProvider().displayName,
        sessionId: h.sessionId,
        status: h.lastStatus === 'running' ? 'thinking' : 'idle',
        lastActivityAt: h.lastRunAt,
        summary: prompt ? prompt.slice(0, 120) : null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.lastActivityAt ?? '') - Date.parse(a.lastActivityAt ?? ''));
}

function label(kind: 'input' | 'output'): string | null {
  const id = kind === 'input' ? primaryServerSpeechInputId() : primaryServerSpeechOutputId();
  if (!id) return null;
  const spec = kind === 'input' ? getSpeechInputSpecializer(id as never) : getSpeechOutputSpecializer(id as never);
  return spec?.displayName ?? id;
}

export function createBridgeOps(api: BridgeApi): BridgeOps {
  return {
    status() {
      const va = getActiveVoiceAgent();
      return {
        workflow: getConfig().settings.workflow.default,
        agentName: getActiveProvider().displayName,
        activeProject: getSessionState('default').activeProject,
        agentRunning: va !== null,
        agentSessionId: va?.sessionId ?? null,
        listener: listenerState(),
        stt: label('input'),
        tts: label('output'),
      };
    },
    projects() {
      const active = getSessionState('default').activeProject;
      return listProjects()
        .filter((p) => p.enabled)
        .map((p) => ({ name: p.name, active: p.name === active }));
    },
    setProject(name) {
      const project = resolveProject(name);
      if (!project) throw new Error(`No project "${name}" — \`projects\` lists them.`);
      setActiveProject('default', project.name);
      return project.name;
    },
    sessions(project) {
      const rows = listSessions(project ? { project } : {}).map(
        (s): SessionRow => ({
          handle: s.handle,
          name: s.name,
          kind: s.kind,
          project: s.project,
          providerName: s.providerName,
          sessionId: s.sessionId,
          status: s.status,
          lastActivityAt: s.lastActivityAt,
          summary: s.summary,
        }),
      );
      return [...rows, ...bridgeHistory(project, new Set(rows.map((r) => r.sessionId).filter(Boolean) as string[]))];
    },
    selectSession(projectName, sessionId) {
      const project = resolveProject(projectName);
      if (!project) throw new Error(`No project "${projectName}".`);
      const provider = getActiveProvider();
      // A thread from another CLI would make the agent exit before it speaks.
      if (provider.sessionStatus?.(project, sessionId) === 'absent') {
        throw new Error(`${provider.displayName} has no conversation ${sessionId.slice(0, 8)} — it belongs to another agent CLI.`);
      }
      setProjectResumeId(project.name, sessionId);
      const va = getActiveVoiceAgent();
      const later = va && va.sessionId !== sessionId ? ' once the agent that is running now finishes' : '';
      return `▶ ${provider.displayName} continues session ${sessionId.slice(0, 8)} on **${project.name}**${later}.`;
    },
    async newSession(project) {
      const result = await handleNewSession(project ? { project } : {}, getSessionState('default').activeProject);
      return result.message;
    },
    stopAgent() {
      return killVoiceAgent('stopped from a channel');
    },
    configKeys() {
      return configKeys().map(({ key, help, choices }) => ({ key, help, ...(choices ? { choices } : {}) }));
    },
    getConfig(key) {
      const k = configKeys().find((c) => c.key === key);
      if (!k) throw new Error(`Unknown setting \`${key}\``);
      return k.get();
    },
    async setConfig(key, value) {
      const k = configKeys().find((c) => c.key === key);
      if (!k) throw new Error(`Unknown setting \`${key}\``);
      return k.set(value, api);
    },
  };
}
