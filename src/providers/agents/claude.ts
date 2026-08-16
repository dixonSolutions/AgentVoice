/**
 * Claude Code CLI (`claude`) provider.
 *
 * Claude Code has no device-code flow. Headless-friendly options are:
 *   - `claude setup-token` — opens a browser OAuth round-trip and prints a
 *     long-lived (1-year) token; we scrape it from stdout and store it as
 *     CLAUDE_CODE_OAUTH_TOKEN. If the spawning host has no browser either,
 *     the CLI still prints the auth URL first, so the phone can complete it.
 *   - ANTHROPIC_API_KEY — plain API key, bypasses OAuth (pay-per-token billing,
 *     not the flat Pro/Max subscription — surfaced in the UI copy).
 *   - Pasting an existing CLAUDE_CODE_OAUTH_TOKEN generated elsewhere.
 *
 * See https://code.claude.com/docs/en/authentication
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childLogger } from '../../log.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveBridgeDataDir, resolveUserHome } from '../../mcp/hostPaths.js';
import { createBinResolver, homeCandidate } from '../binResolve.js';
import { runLoginCommand } from './authFlowRunner.js';
import {
  buildJsonMcpEntry,
  describeAction,
  mergeJsonMcpEntry,
  readJsonConfig,
  registrationFailure,
  writeJsonConfig,
  MCP_SERVER_NAME,
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  extractContentText,
  extractToolUses,
  logUnhandledEvent,
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

const log = childLogger('provider:claude');

/** Generated `--mcp-config` file handed to every `claude` spawn. */
function resolveMcpConfigPath(): string {
  return join(resolveBridgeDataDir(), 'claude-code-mcp.json');
}

/**
 * Tools the voice agent must be allowed to call without an interactive prompt.
 * In `-p` (print) mode Claude Code cannot show a permission dialog, so an
 * un-allowlisted MCP tool is simply denied — which silently removes speak(),
 * done() and next_voice_turn() and makes the whole session mute.
 *
 * `mcp__<server>` allows every tool on that server (the documented wildcard
 * form); listing individual tools would break each time we add one.
 */
const ALLOWED_MCP_TOOLS = `mcp__${MCP_SERVER_NAME}`;

/** Modes that must not be able to modify the repo. */
const READ_ONLY_DISALLOWED = 'Write,Edit,MultiEdit,NotebookEdit';

const resolver = createBinResolver({
  envVar: 'CLAUDE_CODE_PATH',
  candidates: [homeCandidate('.local/bin/claude'), homeCandidate('.claude/bin/claude'), '/usr/local/bin/claude'],
  fallback: 'claude',
});

function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, HOME: base.HOME ?? homedir() };
}

async function checkAuth(): Promise<AuthCheckResult> {
  // No official machine-readable "am I logged in" command; CLAUDE_CODE_OAUTH_TOKEN
  // always wins when set, otherwise fall back to the on-disk credential file that
  // `claude login` / `/login` writes.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return { authenticated: true, email: null, detail: 'Authenticated via environment credential' };
  }
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');
  return { authenticated: existsSync(credentialsPath), email: null };
}

/**
 * Flags every `claude` spawn needs.
 *
 *  --verbose        stream-json output is rejected without it in print mode.
 *  --mcp-config     registers AgentVoice for this process regardless of what
 *                   is (or is not) in the user's global config. Without
 *                   --strict-mcp-config the user's own servers still load.
 *  --allowedTools   print mode cannot prompt, so MCP tools must be pre-approved.
 */
function baseArgs(oneShot: boolean): string[] {
  const args = ['-p', '--output-format', oneShot ? 'json' : 'stream-json'];
  if (!oneShot) args.push('--verbose');
  args.push('--mcp-config', resolveMcpConfigPath(), '--allowedTools', ALLOWED_MCP_TOOLS);
  return args;
}

// ── Stream parsing ────────────────────────────────────────────────────────

function parseClaudeEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  if (typeof raw['session_id'] === 'string' && raw['session_id']) {
    events.push({ kind: 'session', sessionId: raw['session_id'] });
  }

  const type = raw['type'];

  if (type === 'system') {
    if (raw['subtype'] === 'init') {
      events.push({ kind: 'init', model: typeof raw['model'] === 'string' ? raw['model'] : undefined });
    }
    return events;
  }

  if (type === 'assistant') {
    for (const tool of extractToolUses(raw['message'])) {
      events.push({ kind: 'tool_start', tool });
    }
    const text = extractContentText(raw['message']);
    if (text) events.push({ kind: 'assistant_text', text });
    return events;
  }

  if (type === 'user') {
    // tool_result blocks — the matching tool finished.
    const content = (raw['message'] as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const block = part as { type?: string; is_error?: boolean };
        if (block.type !== 'tool_result') continue;
        events.push({
          kind: 'tool_done',
          tool: { name: 'tool_result', action: 'other' },
          success: block.is_error !== true,
        });
      }
    }
    return events;
  }

  if (type === 'result') {
    if (raw['is_error'] === true) {
      events.push({
        kind: 'error',
        message: typeof raw['result'] === 'string' ? raw['result'] : 'Claude Code reported an error',
      });
      return events;
    }
    const text = typeof raw['result'] === 'string' && raw['result'].trim() ? raw['result'].trim() : null;
    events.push({ kind: 'result', text });
    return events;
  }

  if (events.length === 0) logUnhandledEvent('claude-code', raw);
  return events;
}

// ── MCP registration ──────────────────────────────────────────────────────

/**
 * Claude Code's user-scope MCP servers live in `~/.claude.json` (what
 * `claude mcp add --scope user` writes) — NOT in `~/.claude/settings.json`,
 * which only has enable/disable switches. Older AgentVoice builds wrote the
 * latter, so Claude Code never saw the bridge at all and every voice session
 * was silently mute. We now:
 *
 *   1. write the generated `--mcp-config` file (authoritative for our spawns),
 *   2. best-effort merge into `~/.claude.json` for the user's own sessions,
 *   3. strip the useless `mcpServers` block older builds left in settings.json.
 */
async function ensureClaudeMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const mcpConfigPath = resolveMcpConfigPath();
  ctx.log('check', 'info', `Writing Claude Code MCP config (${formatPathForLog(mcpConfigPath)})…`);

  try {
    writeJsonConfig(mcpConfigPath, {
      mcpServers: { [ctx.serverName]: buildJsonMcpEntry(ctx) },
    });
  } catch (err) {
    return registrationFailure(ctx, mcpConfigPath, err);
  }

  const userConfigPath = join(resolveUserHome(), '.claude.json');
  const existing = readJsonConfig(userConfigPath);
  const { file, action, removedLegacy } = mergeJsonMcpEntry(existing, buildJsonMcpEntry(ctx), ctx);
  for (const legacy of removedLegacy) {
    ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${formatPathForLog(userConfigPath)}.`);
  }
  try {
    writeJsonConfig(userConfigPath, file);
    ctx.log('enable', 'info', `${ctx.serverName} registered in ${formatPathForLog(userConfigPath)}.`);
  } catch (err) {
    // Non-fatal: our own spawns already carry --mcp-config.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('error', 'warn', `Could not update ${formatPathForLog(userConfigPath)}: ${message}`);
  }

  cleanupLegacySettingsMcp(ctx);

  ctx.log('done', 'info', 'Claude Code MCP ready — every spawn is launched with --mcp-config.');
  return { ok: true, configPath: mcpConfigPath, action, message: describeAction(action, 'Claude Code') };
}

/** Remove the `mcpServers` block older builds wrote into `~/.claude/settings.json`. */
function cleanupLegacySettingsMcp(ctx: McpRegistrationContext): void {
  const settingsPath = join(resolveUserHome(), '.claude', 'settings.json');
  const settings = readJsonConfig(settingsPath);
  if (!settings?.mcpServers) return;

  const names = [ctx.serverName, ...ctx.legacyServerNames];
  let changed = false;
  for (const name of names) {
    if (settings.mcpServers[name]) {
      delete settings.mcpServers[name];
      changed = true;
    }
  }
  if (!changed) return;

  try {
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    writeJsonConfig(settingsPath, settings);
    ctx.log(
      'update',
      'info',
      `Removed the no-op mcpServers entry from ${formatPathForLog(settingsPath)} (Claude Code reads ~/.claude.json).`,
    );
  } catch {
    // Cosmetic cleanup only — never fail the prepare over it.
  }
}

export const claudeProvider: AgentProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  env: claudeEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Generate a setup token',
        description:
          'Claude Code opens a sign-in link — tap it on your phone, then the token is captured automatically.',
      },
      {
        id: 'token-paste',
        label: 'Paste a setup token',
        description: 'Already ran "claude setup-token" elsewhere? Paste the token here.',
        pasteLabel: 'Setup token',
        pastePlaceholder: 'sk-ant-oat...',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an Anthropic API key (bills pay-per-token, not your Pro/Max subscription).',
        pasteLabel: 'Anthropic API key',
        pastePlaceholder: 'sk-ant-api...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'token-paste' || flowId === 'api-key') {
      const pasted = opts?.pasted?.trim();
      if (!pasted || pasted.length < 8) {
        throw new Error('Paste a valid token or API key.');
      }
      updateAgentEnvKeys(
        flowId === 'api-key' ? { ANTHROPIC_API_KEY: pasted } : { CLAUDE_CODE_OAUTH_TOKEN: pasted },
      );
      const result = await checkAuth();
      return { flow: flowId, instructions: 'Credential saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Claude Code does not support the "${flowId}" login flow.`);
    }

    const result = await runLoginCommand({
      bin: resolver.resolve(),
      args: ['setup-token'],
      env: claudeEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      verify: async () => ({ authenticated: false, email: null }), // token capture below decides success
      instructions: 'Open the link on your phone, sign in, and approve access — the token is saved automatically.',
      flowId,
      totalTimeoutMs: 3 * 60_000,
    });

    // setup-token prints the token itself right before exit; scrape it from the
    // same login command instead of relying on generic verify().
    const done = result.done.then(async () => {
      const check = await checkAuth();
      return check;
    });

    return { ...result, done };
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|invalid api key|authentication_error|please run.*login|401|unauthorized/i.test(stderr);
  },

  async listModels(): Promise<ModelEntry[]> {
    // Claude Code has no CLI model-listing command; expose the documented
    // aliases. "auto" is the shared no-flag sentinel every provider honours —
    // it means "let the CLI pick", so no --model is passed.
    return [
      { id: 'auto', displayName: 'Auto (subscription plan default)' },
      { id: 'opus', displayName: 'Claude Opus' },
      { id: 'sonnet', displayName: 'Claude Sonnet' },
      { id: 'haiku', displayName: 'Claude Haiku' },
    ];
  },

  // Claude Code takes `--model <alias>`, so the picker is live for it too.
  supportsModelSelection: () => true,

  supportedModes: (): readonly AgentMode[] => ['agent', 'plan', 'ask'],
  parseStreamEvent: parseClaudeEvent,
  ensureMcpRegistration: ensureClaudeMcpRegistration,

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, session, prompt, mode = 'agent', oneShot = false, browser } = opts;
    const args = baseArgs(oneShot);

    if (session.activeModel && session.activeModel !== 'auto') {
      args.push('--model', session.activeModel);
    }
    if (project.resumeId && !oneShot && mode !== 'ask') {
      args.push('--resume', project.resumeId);
    }

    // Print mode has no permission UI: without an explicit mode, edits are denied
    // and the worker silently produces nothing. `ask`/`plan` stay read-only.
    if (mode === 'ask' || mode === 'plan') {
      args.push('--permission-mode', 'plan', '--disallowedTools', READ_ONLY_DISALLOWED);
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
    return args;
  },

  buildVoiceArgs(project: Project, session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args = baseArgs(false);
    if (session.activeModel && session.activeModel !== 'auto') {
      args.push('--model', session.activeModel);
    }
    if (project.resumeId) args.push('--resume', project.resumeId);
    args.push('--permission-mode', 'acceptEdits');
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'claude provider ready');
