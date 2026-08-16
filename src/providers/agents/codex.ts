/**
 * OpenAI Codex CLI (`codex`) provider.
 *
 * Auth: `codex login --device-auth` prints a URL + short one-time code that
 * can be completed from ANY browser (true RFC 8628-style device flow — no
 * localhost callback), which is exactly what a phone-only user needs. Device
 * code auth must be enabled on the account/workspace; if it is not, the CLI
 * reports that clearly and we surface it as the login instructions.
 * Fallback: OPENAI_API_KEY env var.
 *
 * See https://developers.openai.com/codex/auth
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { childLogger } from '../../log.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveUserHome } from '../../mcp/hostPaths.js';
import { createBinResolver, homeCandidate } from '../binResolve.js';
import { runLoginCommand } from './authFlowRunner.js';
import {
  describeAction,
  isOlderVersion,
  registrationFailure,
  type McpRegistrationAction,
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  logUnhandledEvent,
  normalizeToolCall,
  type AgentStreamEvent,
} from './events.js';
import type {
  AgentMode,
  AgentProvider,
  AuthCheckResult,
  AuthFlowDescriptor,
  AuthFlowId,
  AuthStartResult,
  ModelEntry,
  SpawnOptions,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = childLogger('provider:codex');

const resolver = createBinResolver({
  envVar: 'CODEX_PATH',
  candidates: [homeCandidate('.local/bin/codex'), homeCandidate('.codex/bin/codex'), '/usr/local/bin/codex'],
  fallback: 'codex',
});

function codexEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Codex reads OPENAI_API_KEY itself for API-key auth — never strip it here.
  // AGENTVOICE_MCP_TOKEN is what config.toml's bearer_token_env_var points at,
  // so the bridge token never has to be written into a config file.
  return {
    ...base,
    HOME: base.HOME ?? homedir(),
    [CODEX_TOKEN_ENV_VAR]: base.APP_TOKEN ?? process.env.APP_TOKEN,
  };
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['login', 'status'], {
      timeout: 10_000,
      env: codexEnv(process.env),
    });
    const authenticated = /authenticated:\s*yes/i.test(stdout);
    const emailMatch = stdout.match(/account:\s*(\S+@\S+)/i);
    return { authenticated, email: emailMatch?.[1] ?? null };
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Stream parsing ────────────────────────────────────────────────────────

/**
 * Codex has shipped two `--json` shapes. Both are handled:
 *
 *   legacy   { id, msg: { type: "exec_command_begin", command: [...] } }
 *   current  { type: "item.started", item: { item_type: "command_execution" } }
 *
 * Critically, the session id is NEVER at the top level in either shape — the
 * old code only looked at `raw.session_id`, so Codex resume never worked.
 */
function parseCodexEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  const msg =
    typeof raw['msg'] === 'object' && raw['msg'] !== null
      ? (raw['msg'] as Record<string, unknown>)
      : null;
  const item =
    typeof raw['item'] === 'object' && raw['item'] !== null
      ? (raw['item'] as Record<string, unknown>)
      : null;

  const sessionId =
    pickId(msg, ['session_id', 'thread_id', 'conversation_id']) ??
    pickId(raw, ['session_id', 'thread_id', 'conversation_id']);
  if (sessionId) events.push({ kind: 'session', sessionId });

  const type = String(msg?.['type'] ?? raw['type'] ?? '');

  switch (type) {
    case 'session_configured':
    case 'thread.started':
      events.push({
        kind: 'init',
        model: typeof msg?.['model'] === 'string' ? (msg['model'] as string) : undefined,
      });
      return events;

    case 'agent_message':
    case 'agent_message_delta': {
      const text = typeof msg?.['message'] === 'string' ? msg['message'].trim() : '';
      if (text) events.push({ kind: 'assistant_text', text });
      return events;
    }

    case 'exec_command_begin':
      events.push({ kind: 'tool_start', tool: normalizeToolCall('exec_command', msg ?? undefined) });
      return events;

    case 'exec_command_end':
      events.push({
        kind: 'tool_done',
        tool: normalizeToolCall('exec_command', msg ?? undefined),
        success: msg?.['exit_code'] === 0,
      });
      return events;

    case 'patch_apply_begin': {
      const changes = msg?.['changes'];
      const paths = typeof changes === 'object' && changes !== null ? Object.keys(changes) : [];
      for (const path of paths.length > 0 ? paths : [undefined]) {
        events.push({ kind: 'tool_start', tool: normalizeToolCall('apply_patch', path ? { path } : undefined) });
      }
      return events;
    }

    case 'mcp_tool_call_begin':
    case 'mcp_tool_call_end': {
      const invocation = msg?.['invocation'] as Record<string, unknown> | undefined;
      const name = typeof invocation?.['tool'] === 'string' ? invocation['tool'] : 'mcp_tool';
      events.push(
        type.endsWith('begin')
          ? { kind: 'tool_start', tool: normalizeToolCall(name, invocation) }
          : { kind: 'tool_done', tool: normalizeToolCall(name, invocation) },
      );
      return events;
    }

    case 'item.started':
    case 'item.completed': {
      const itemType = String(item?.['item_type'] ?? item?.['type'] ?? '');
      if (!itemType) return events;
      if (itemType === 'agent_message') {
        const text = typeof item?.['text'] === 'string' ? item['text'].trim() : '';
        if (text) events.push({ kind: 'assistant_text', text });
        return events;
      }
      events.push(
        type === 'item.started'
          ? { kind: 'tool_start', tool: normalizeToolCall(itemType, item ?? undefined) }
          : { kind: 'tool_done', tool: normalizeToolCall(itemType, item ?? undefined) },
      );
      return events;
    }

    case 'task_complete':
    case 'turn.completed': {
      const text =
        (typeof msg?.['last_agent_message'] === 'string' ? msg['last_agent_message'] : null) ?? null;
      events.push({ kind: 'result', text: text && text.trim() ? text.trim() : null });
      return events;
    }

    case 'error':
    case 'turn.failed': {
      const message =
        (typeof msg?.['message'] === 'string' ? msg['message'] : null) ??
        (typeof raw['message'] === 'string' ? raw['message'] : null) ??
        'Codex reported an error';
      events.push({ kind: 'error', message });
      return events;
    }

    default:
      if (events.length === 0) logUnhandledEvent('codex', raw);
      return events;
  }
}

function pickId(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

// ── MCP registration (~/.codex/config.toml) ───────────────────────────────

function resolveCodexConfigPath(): string {
  return join(resolveUserHome(), '.codex', 'config.toml');
}

/**
 * Env var name Codex reads the bearer token from. Passing the token by env var
 * rather than writing it into config.toml keeps the secret out of a file that
 * users routinely paste into issues.
 */
export const CODEX_TOKEN_ENV_VAR = 'AGENTVOICE_MCP_TOKEN';

/**
 * Remove `[mcp_servers.<name>]` and any of its sub-tables from a TOML document.
 * Table-header based, so it stops at the next top-level `[` and cannot eat
 * unrelated config the way the previous greedy regex could.
 */
function stripTomlServer(toml: string, name: string): string {
  const lines = toml.split('\n');
  const kept: string[] = [];
  let skipping = false;
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.["']?${escapeRegex(name)}["']?(\\.[^\\]]+)?\\s*\\]`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = header.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RMCP_FLAG = 'experimental_use_rmcp_client';

/** The `[mcp_servers."agent-voice"]` table, appended at the end of the document. */
function buildCodexTomlEntry(ctx: McpRegistrationContext): string {
  return [
    '',
    `# AgentVoice MCP registration — version ${ctx.version} (managed by AgentVoice, safe to delete)`,
    `[mcp_servers."${ctx.serverName}"]`,
    `url = "${ctx.url}"`,
    `bearer_token_env_var = "${CODEX_TOKEN_ENV_VAR}"`,
    'enabled = true',
    '',
  ].join('\n');
}

/**
 * Ensure `experimental_use_rmcp_client = true` sits at document top level.
 *
 * That flag is what enables streamable-HTTP MCP servers — without it Codex only
 * speaks stdio and ignores a `url` entry entirely. In TOML a bare key belongs to
 * the most recent table header, so appending it at the end of the file would
 * silently make it a key of whatever table came last, not a global setting.
 */
function ensureRmcpFlag(toml: string): string {
  if (new RegExp(`^\\s*${RMCP_FLAG}\\s*=`, 'm').test(toml)) {
    const firstTable = toml.search(/^\s*\[/m);
    const flagIndex = toml.search(new RegExp(`^\\s*${RMCP_FLAG}\\s*=`, 'm'));
    // Already present *and* above every table header — nothing to do.
    if (firstTable === -1 || flagIndex < firstTable) return toml;
    toml = toml.replace(new RegExp(`^\\s*${RMCP_FLAG}\\s*=.*$`, 'gm'), '').replace(/\n{3,}/g, '\n\n');
  }
  return `${RMCP_FLAG} = true\n${toml.startsWith('\n') ? '' : '\n'}${toml.trimStart()}`;
}

async function ensureCodexMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const configPath = resolveCodexConfigPath();
  const label = formatPathForLog(configPath);
  ctx.log('check', 'info', `Checking Codex MCP config (${label})…`);

  let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const versionMatch = content.match(/# AgentVoice MCP registration — version ([\d.]+)/);
  const installedVersion = versionMatch?.[1] ?? null;
  const registered = content.includes(`[mcp_servers."${ctx.serverName}"]`);

  let action: McpRegistrationAction = 'unchanged';
  if (!registered) action = 'installed';
  else if (isOlderVersion(installedVersion, ctx.version)) action = 'updated';

  for (const legacy of ctx.legacyServerNames) {
    if (content.includes(`mcp_servers.${legacy}`) || content.includes(`mcp_servers."${legacy}"`)) {
      content = stripTomlServer(content, legacy);
      ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${label}.`);
      if (action === 'unchanged') action = 'updated';
    }
  }

  if (action !== 'unchanged') {
    content = stripTomlServer(content, ctx.serverName)
      .replace(/^# AgentVoice MCP registration.*$/gm, '')
      .trimEnd();
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, ensureRmcpFlag(`${content}${buildCodexTomlEntry(ctx)}`), 'utf-8');
      ctx.log('done', 'info', `Codex MCP config ${action} at ${label}.`);
    } catch (err) {
      return registrationFailure(ctx, configPath, err);
    }
  } else {
    ctx.log('check', 'info', `${ctx.serverName} already registered in ${label} (version ${installedVersion}).`);
  }

  return { ok: true, configPath, action, message: describeAction(action, 'Codex') };
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  env: codexEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'device-code',
        label: 'Sign in with a device code',
        description: 'Open the link on any device, enter the one-time code, and Codex links this machine.',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an OpenAI API key instead of signing in with ChatGPT.',
        pasteLabel: 'OpenAI API key',
        pastePlaceholder: 'sk-...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const key = opts?.pasted?.trim();
      if (!key || key.length < 8) {
        throw new Error('Paste a valid OpenAI API key.');
      }
      updateAgentEnvKeys({ OPENAI_API_KEY: key });
      const result = await checkAuth();
      return { flow: flowId, instructions: 'API key saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'device-code') {
      throw new Error(`Codex does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login', '--device-auth'],
      env: codexEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      codePattern: /\b([A-Z0-9]{4}-[A-Z0-9]{4}(?:-[A-Z0-9]{4})?)\b/,
      verify: checkAuth,
      instructions:
        'Open the link on any device signed in to ChatGPT, then enter the one-time code to link this machine. ' +
        'If it fails immediately, device-code login may be disabled in your ChatGPT security settings.',
      flowId,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|not authenticated|please run.*login|401|unauthorized|sign in/i.test(stderr);
  },

  async listModels(): Promise<ModelEntry[]> {
    // Codex has no `codex models` listing command — model choice is config-driven
    // (~/.codex/config.toml [model_providers]). Surface the common presets so the
    // picker still has something real to show, and let advanced users set the
    // model in Codex's own config for anything not listed here.
    return [
      { id: 'auto', displayName: 'Auto (from ~/.codex/config.toml)' },
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
      { id: 'o4-mini', displayName: 'o4-mini' },
    ];
  },

  // `codex exec -m <model>` overrides the config default per run.
  supportsModelSelection: () => true,

  // Codex has no plan mode; `ask` is enforced with a read-only sandbox.
  supportedModes: (): readonly AgentMode[] => ['agent', 'ask'],
  parseStreamEvent: parseCodexEvent,
  ensureMcpRegistration: ensureCodexMcpRegistration,

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, session, prompt, mode = 'agent', oneShot = false, worktree, browser } = opts;
    const args: string[] = ['exec'];

    if (project.resumeId && !oneShot && mode !== 'ask' && !worktree) {
      args.push('resume', project.resumeId);
    }
    args.push('--json', '--sandbox', mode === 'ask' ? 'read-only' : 'workspace-write');
    // Worktree runs must not touch the main checkout.
    args.push('--cd', worktree ?? project.path);
    if (session.activeModel && session.activeModel !== 'auto') {
      args.push('-m', session.activeModel);
    }
    args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
    return args;
  },

  buildVoiceArgs(project: Project, session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args: string[] = ['exec'];
    if (project.resumeId) args.push('resume', project.resumeId);
    args.push('--json', '--sandbox', 'workspace-write', '--cd', project.path);
    if (session.activeModel && session.activeModel !== 'auto') {
      args.push('-m', session.activeModel);
    }
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'codex provider ready');
