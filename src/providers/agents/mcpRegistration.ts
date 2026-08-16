/**
 * Shared plumbing for registering the AgentVoice MCP server with a coding CLI.
 *
 * Each CLI stores MCP servers somewhere different, in a different format:
 *
 *   Cursor      ~/.cursor/mcp.json        JSON  { mcpServers: { … } }
 *   Codex       ~/.codex/config.toml      TOML  [mcp_servers.<name>]
 *   Claude Code ~/.claude.json            JSON  { mcpServers: { … } }  (+ --mcp-config at spawn)
 *
 * The *policy* (which server name, which URL, which version) is shared and
 * lives here; the *mechanics* live in each provider file. Nothing outside
 * providers/agents/ needs to know any of these paths exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatPathForLog } from '../../mcp/hostPaths.js';

/** Canonical MCP server key. Renamed from `cursor-voice` — see MCP_LEGACY_SERVER_NAMES. */
export const MCP_SERVER_NAME = 'agent-voice';

/**
 * Server keys written by older builds. Every prepare removes these so a stale
 * entry pointing at a dead port can never register a second, conflicting
 * server alongside the live one.
 */
export const MCP_LEGACY_SERVER_NAMES = ['cursor-voice'] as const;

/** Bump when the generated MCP entry shape or defaults change. */
export const MCP_ENTRY_VERSION = '0.3.0';

export type McpSetupPhase = 'check' | 'install' | 'update' | 'enable' | 'done' | 'error';
export type McpSetupLevel = 'info' | 'warn' | 'error';

export interface McpSetupLogEvent {
  phase: McpSetupPhase;
  level: McpSetupLevel;
  message: string;
  at: string;
}

export type McpSetupLogger = (
  phase: McpSetupPhase,
  level: McpSetupLevel,
  message: string,
) => void;

export interface McpRegistrationContext {
  /** Canonical server key to write. */
  serverName: string;
  /** Older keys to strip on sight. */
  legacyServerNames: readonly string[];
  version: string;
  /** Loopback bridge URL — the CLI always runs on the bridge host. */
  url: string;
  /** APP_TOKEN, sent as `Authorization: Bearer …`. */
  token: string;
  /**
   * The AgentVoice system prompt, for CLIs that persist rules in a file
   * (Cursor's `.mdc`). Passed in rather than imported, because the prompt
   * loader itself resolves the *active provider* for `{{AGENT_DISPLAY_NAME}}` —
   * a provider importing it directly creates an import cycle through the
   * registry that only bites depending on module load order.
   */
  ruleBody: () => string;
  log: McpSetupLogger;
}

export type McpRegistrationAction = 'installed' | 'updated' | 'unchanged' | 'enabled';

export interface McpRegistrationResult {
  ok: boolean;
  /** Config file the provider wrote (shown in the PWA prepare log). */
  configPath: string;
  action: McpRegistrationAction;
  message: string;
}

// ── Version helpers ───────────────────────────────────────────────────────

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isOlderVersion(installed: string | null | undefined, current: string): boolean {
  if (!installed) return true;
  return compareVersions(installed, current) < 0;
}

// ── JSON config helpers (Cursor + Claude Code) ────────────────────────────

export interface JsonMcpEntry {
  type?: string;
  transport?: string;
  url: string;
  headers?: Record<string, string>;
  /** AgentVoice bookkeeping so we know when to rewrite the entry. */
  agentVoice?: { version: string; enabled: boolean };
  disabled?: boolean;
  [key: string]: unknown;
}

export interface JsonMcpFile {
  mcpServers?: Record<string, JsonMcpEntry>;
  [key: string]: unknown;
}

export function readJsonConfig(path: string): JsonMcpFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as JsonMcpFile;
  } catch {
    return null;
  }
}

export function writeJsonConfig(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Merge the AgentVoice entry into a JSON `mcpServers` map, dropping legacy keys.
 * Returns the merged file plus the action that describes what changed, so the
 * caller can skip the write when nothing moved.
 */
export function mergeJsonMcpEntry(
  existing: JsonMcpFile | null,
  entry: JsonMcpEntry,
  ctx: McpRegistrationContext,
): { file: JsonMcpFile; action: McpRegistrationAction; removedLegacy: string[] } {
  const file: JsonMcpFile = existing ? { ...existing } : {};
  const servers: Record<string, JsonMcpEntry> = { ...(file.mcpServers ?? {}) };

  const removedLegacy: string[] = [];
  for (const legacy of ctx.legacyServerNames) {
    if (legacy !== ctx.serverName && servers[legacy]) {
      delete servers[legacy];
      removedLegacy.push(legacy);
    }
  }

  const current = servers[ctx.serverName];
  let action: McpRegistrationAction;
  if (!current) {
    action = 'installed';
  } else if (isOlderVersion(current.agentVoice?.version, ctx.version) || current.url !== entry.url) {
    action = 'updated';
  } else if (current.disabled === true || current.agentVoice?.enabled === false) {
    action = 'enabled';
  } else {
    action = 'unchanged';
  }

  servers[ctx.serverName] = {
    ...current,
    ...entry,
    agentVoice: { version: ctx.version, enabled: true },
    disabled: false,
  };

  file.mcpServers = servers;
  return { file, action, removedLegacy };
}

/** The HTTP MCP entry every JSON-config CLI understands. */
export function buildJsonMcpEntry(ctx: McpRegistrationContext): JsonMcpEntry {
  return {
    type: 'http',
    transport: 'http',
    url: ctx.url,
    headers: { Authorization: `Bearer ${ctx.token}` },
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────

export function describeAction(action: McpRegistrationAction, label: string): string {
  switch (action) {
    case 'installed':
      return `${label} MCP installed and enabled — you can start voice.`;
    case 'updated':
      return `${label} MCP updated and enabled — you can start voice.`;
    case 'enabled':
      return `${label} MCP enabled — you can start voice.`;
    default:
      return `${label} MCP ready — you can start voice.`;
  }
}

export function registrationFailure(
  ctx: McpRegistrationContext,
  configPath: string,
  err: unknown,
): McpRegistrationResult {
  const message = err instanceof Error ? err.message : String(err);
  ctx.log('error', 'error', `Could not write ${formatPathForLog(configPath)}: ${message}`);
  return { ok: false, configPath, action: 'unchanged', message };
}
