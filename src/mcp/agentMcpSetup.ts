/**
 * Register the AgentVoice MCP server with whichever coding CLI is active.
 *
 * This module owns only the *policy*: which server name, which URL, which
 * version, and the legacy-entry cleanup that has to happen for every CLI.
 * The per-CLI mechanics (config path, file format, extra flags) live in
 * `src/providers/agents/<client>.ts` behind `ensureMcpRegistration()`, so
 * adding a fourth CLI still means one new provider file and nothing else.
 *
 * Called on every voice-session prepare — must stay idempotent.
 *
 * See docs/16-mcp-server-agent-as-brain.md and docs/23-multi-agent-client.md.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getConfig, type AgentClient } from '../config.js';
import { getRunModeInfo } from '../runMode.js';
import { resolveProject } from '../state/registry.js';
import { getProvider } from '../providers/agents/registry.js';
import {
  MCP_ENTRY_VERSION,
  MCP_LEGACY_SERVER_NAMES,
  MCP_SERVER_NAME,
  readJsonConfig,
  writeJsonConfig,
  type McpRegistrationContext,
  type McpSetupLogEvent,
  type McpSetupLevel,
  type McpSetupPhase,
} from '../providers/agents/mcpRegistration.js';
import { childLogger } from '../log.js';
import { agentVoiceRuleBody } from './agentVoicePrompt.js';
import {
  detectHostOs,
  formatPathForLog,
  resolveUserProjectsRoot,
  resolveUserHome,
} from './hostPaths.js';

const log = childLogger('mcp:setup');

export { MCP_SERVER_NAME, MCP_ENTRY_VERSION };
export type SessionLogEvent = McpSetupLogEvent;
export type SessionLogLevel = McpSetupLevel;
export type SessionLogCallback = (event: SessionLogEvent) => void;

export interface PrepareMcpResult {
  ok: boolean;
  scope: 'global';
  mcpPath: string;
  userRoot: string;
  hostOs: string;
  action: 'installed' | 'updated' | 'unchanged' | 'enabled';
  version: string;
  message: string;
}

function makeLogger(onLog: SessionLogCallback | undefined) {
  return (phase: McpSetupPhase, level: McpSetupLevel, message: string): void => {
    const event: SessionLogEvent = { phase, level, message, at: new Date().toISOString() };
    onLog?.(event);
    if (level === 'error') log.warn({ phase, message }, 'mcp prepare');
    else log.debug({ phase, message }, 'mcp prepare');
  };
}

/**
 * MCP URL the CLI dials. Always loopback — the agent CLI runs on the bridge
 * host; publicBaseUrl is for the PWA only.
 */
function resolveMcpBridgeUrl(): string {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  return `${run.backendUrl.replace(/\/$/, '')}/mcp`;
}

function buildContext(log: McpRegistrationContext['log']): McpRegistrationContext {
  const { env } = getConfig();
  return {
    serverName: MCP_SERVER_NAME,
    legacyServerNames: MCP_LEGACY_SERVER_NAMES,
    version: MCP_ENTRY_VERSION,
    url: resolveMcpBridgeUrl(),
    token: env.APP_TOKEN,
    ruleBody: agentVoiceRuleBody,
    log,
  };
}

/**
 * Ensure the AgentVoice MCP server is registered for `client`.
 * Delegates to the provider; this wrapper only supplies shared context and
 * shapes the result the PWA's prepare stream expects.
 */
export async function ensureClientMcpSetup(
  client: AgentClient,
  onLog?: SessionLogCallback,
): Promise<PrepareMcpResult> {
  const emit = makeLogger(onLog);
  const ctx = buildContext(emit);
  const provider = getProvider(client);
  const userRoot = resolveUserProjectsRoot();
  const hostOs = detectHostOs();

  emit('check', 'info', `Preparing ${provider.displayName} MCP registration on ${hostOs}…`);

  try {
    const result = await provider.ensureMcpRegistration(ctx);
    return {
      ok: result.ok,
      scope: 'global',
      mcpPath: result.configPath,
      userRoot,
      hostOs,
      action: result.action,
      version: MCP_ENTRY_VERSION,
      message: result.message,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit('error', 'error', `${provider.displayName} MCP registration failed: ${message}`);
    return {
      ok: false,
      scope: 'global',
      mcpPath: '',
      userRoot,
      hostOs,
      action: 'unchanged',
      version: MCP_ENTRY_VERSION,
      message,
    };
  }
}

/**
 * Remove AgentVoice entries from a project-level `.cursor/mcp.json`.
 *
 * The global config is the single source of truth and always points at the
 * live bridge port. A leftover project-level entry (e.g. from an older install
 * on a different port) registers a SECOND server under the same name, and the
 * agent may then connect to a dead port — tool lookups fail intermittently.
 * Only our own entries are stripped; other MCP servers are preserved.
 */
export function cleanupLegacyProjectMcp(
  projectName: string | undefined,
  onLog?: SessionLogCallback,
): void {
  if (!projectName) return;
  const project = resolveProject(projectName);
  if (!project) return;
  const emit = makeLogger(onLog);

  const legacyPath = resolve(join(project.path, '.cursor', 'mcp.json'));
  const globalPath = resolve(join(resolveUserHome(), '.cursor', 'mcp.json'));

  // A project rooted at $HOME resolves `.cursor/mcp.json` to the GLOBAL config.
  // Never strip that file — it is the authoritative registration.
  if (legacyPath === globalPath) {
    emit(
      'check',
      'info',
      `Skipping project MCP cleanup for ${formatPathForLog(project.path)} — that path is the global Cursor MCP config.`,
    );
    return;
  }

  if (!existsSync(legacyPath)) return;

  const file = readJsonConfig(legacyPath);
  const servers = file?.mcpServers;
  if (!servers) return;

  const ours = [MCP_SERVER_NAME, ...MCP_LEGACY_SERVER_NAMES].filter((name) => servers[name]);
  if (ours.length === 0) return;

  const label = formatPathForLog(legacyPath);
  for (const name of ours) delete servers[name];

  try {
    if (Object.keys(servers).length === 0) {
      unlinkSync(legacyPath);
      emit('update', 'info', `Removed stale project ${label} — the global config is authoritative.`);
    } else {
      writeJsonConfig(legacyPath, file);
      emit('update', 'info', `Removed stale ${ours.join(', ')} entr${ours.length === 1 ? 'y' : 'ies'} from ${label}.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit('error', 'warn', `Could not clean stale project ${label}: ${message}`);
  }
}
