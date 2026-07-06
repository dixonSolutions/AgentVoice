/**
 * Ensure Cursor's **global** ~/.cursor/mcp.json registers the cursor-voice bridge.
 *
 * On voice session start the bridge:
 *   1. Checks whether cursor-voice MCP config exists in the global Cursor config
 *   2. Installs from template if missing
 *   3. Compares embedded version — updates if older
 *   4. Enables the server entry
 *
 * Project-level `.cursor/mcp.json` is not required (and is not written). Any stale
 * project-level cursor-voice entry is removed on session prepare so it can't
 * register a second, conflicting server pointing at an outdated port.
 * See docs/16-mcp-server-cursor-as-brain.md.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from '../config.js';
import { getRunModeInfo } from '../runMode.js';
import { resolveProject } from '../state/registry.js';
import { childLogger } from '../log.js';
import {
  detectCursorHostOs,
  formatPathForLog,
  resolveCursorVoiceUserRoot,
  resolveGlobalMcpJsonPath,
  resolveUserHome,
} from './cursorPaths.js';
import { cursorVoiceRuleBody } from './loadCursorVoicePrompt.js';

const log = childLogger('mcp:global-setup');

/** Bump when the generated mcp.json shape or defaults change. */
export const CURSOR_VOICE_MCP_VERSION = '0.2.3';

export const CURSOR_VOICE_MCP_SERVER_NAME = 'cursor-voice';

export type SessionLogLevel = 'info' | 'warn' | 'error';

export interface SessionLogEvent {
  phase: 'check' | 'install' | 'update' | 'enable' | 'done' | 'error';
  level: SessionLogLevel;
  message: string;
  at: string;
}

export interface CursorVoiceMcpMeta {
  version: string;
  enabled: boolean;
}

export interface McpServerEntry {
  url: string;
  transport: string;
  headers?: Record<string, string>;
  cursorVoice?: CursorVoiceMcpMeta;
  disabled?: boolean;
}

export interface GlobalMcpFile {
  mcpServers: Record<string, McpServerEntry>;
}

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

export type SessionLogCallback = (event: SessionLogEvent) => void;

function emitLog(
  onLog: SessionLogCallback | undefined,
  phase: SessionLogEvent['phase'],
  level: SessionLogLevel,
  message: string,
): void {
  const event: SessionLogEvent = {
    phase,
    level,
    message,
    at: new Date().toISOString(),
  };
  onLog?.(event);
  if (level === 'error') log.warn({ phase, message }, 'mcp prepare');
  else log.debug({ phase, message }, 'mcp prepare');
}

function compareVersions(a: string, b: string): number {
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

/**
 * MCP URL for cursor-agent's ~/.cursor/mcp.json.
 * Always loopback — cursor-agent runs on the bridge host; publicBaseUrl is for the PWA only.
 */
function resolveMcpBridgeUrl(): string {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  const base = run.backendUrl.replace(/\/$/, '');
  return `${base}/mcp`;
}

function buildCursorVoiceEntry(appToken: string): McpServerEntry {
  return {
    url: resolveMcpBridgeUrl(),
    transport: 'http',
    headers: {
      Authorization: `Bearer ${appToken}`,
    },
    cursorVoice: {
      version: CURSOR_VOICE_MCP_VERSION,
      enabled: true,
    },
  };
}

function parseMcpFile(raw: string): GlobalMcpFile | null {
  try {
    const parsed = JSON.parse(raw) as GlobalMcpFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readGlobalMcpFile(mcpPath: string): GlobalMcpFile | null {
  if (!existsSync(mcpPath)) return null;
  try {
    return parseMcpFile(readFileSync(mcpPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeGlobalMcpFile(mcpPath: string, data: GlobalMcpFile): void {
  mkdirSync(dirname(mcpPath), { recursive: true });
  writeFileSync(mcpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

const CURSOR_VOICE_RULE_NAME = 'cursor-voice.mdc';

function ensureGlobalCursorVoiceRule(onLog?: SessionLogCallback): void {
  const rulePath = join(resolveUserHome(), '.cursor', 'rules', CURSOR_VOICE_RULE_NAME);
  const ruleLabel = formatPathForLog(rulePath);
  const body = cursorVoiceRuleBody();
  const content = `---
description: >
  Cursor Voice — use only during an active phone/PWA voice session.
  When a voice session is connected, all communication MUST go through cursor-voice MCP tools:
  speak() to talk, done() to re-arm the mic, next_voice_turn() to receive requests.
  If speak() returns NO_VOICE_SESSION, respond with normal IDE text instead.
  Text-only replies are invisible to the hands-free user.
alwaysApply: false
---

${body}
`;

  try {
    mkdirSync(dirname(rulePath), { recursive: true });
    const exists = existsSync(rulePath);
    writeFileSync(rulePath, content, 'utf-8');
    emitLog(
      onLog,
      exists ? 'update' : 'install',
      'info',
      exists
        ? `Updated Cursor rule ${ruleLabel} — enable in Settings → Rules when running voice`
        : `Installed Cursor rule ${ruleLabel} — enable in Settings → Rules for voice mode`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitLog(onLog, 'error', 'warn', `Could not write ${ruleLabel}: ${message}`);
  }
}

/**
 * Remove a stale project-level cursor-voice entry from `.cursor/mcp.json`.
 *
 * The global ~/.cursor/mcp.json is the single source of truth and always points
 * at the live bridge URL/port. A leftover project-level entry (e.g. from an older
 * install that used a different port) registers a SECOND, conflicting
 * "cursor-voice" server in Cursor — the agent may then connect to a dead port and
 * resource/tool lookups fail intermittently. We strip only our own entry,
 * preserving any other MCP servers the user configured, and delete the file if it
 * becomes empty.
 */
export function cleanupLegacyProjectMcp(
  projectName: string | undefined,
  onLog?: SessionLogCallback,
): void {
  if (!projectName) return;
  const project = resolveProject(projectName);
  if (!project) return;

  const legacyPath = join(project.path, '.cursor', 'mcp.json');
  if (!existsSync(legacyPath)) return;

  const legacy = readGlobalMcpFile(legacyPath);
  if (!legacy?.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME]) return;

  const legacyUrl = legacy.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME]?.url ?? 'unknown URL';
  delete legacy.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME];
  const label = formatPathForLog(legacyPath);

  try {
    if (Object.keys(legacy.mcpServers).length === 0) {
      unlinkSync(legacyPath);
      emitLog(
        onLog,
        'update',
        'info',
        `Removed stale project ${label} (registered cursor-voice at ${legacyUrl}) — global ${formatPathForLog(resolveGlobalMcpJsonPath())} is authoritative.`,
      );
    } else {
      writeGlobalMcpFile(legacyPath, legacy);
      emitLog(
        onLog,
        'update',
        'info',
        `Removed stale cursor-voice entry (${legacyUrl}) from project ${label} — kept other MCP servers; global config is authoritative.`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitLog(onLog, 'error', 'warn', `Could not clean stale project ${label}: ${message}`);
  }
}

/**
 * Ensure cursor-voice MCP registration exists in Cursor's global config.
 */
export async function ensureGlobalMcpSetup(
  onLog?: SessionLogCallback,
): Promise<PrepareMcpResult> {
  const mcpPath = resolveGlobalMcpJsonPath();
  const userRoot = resolveCursorVoiceUserRoot();
  const hostOs = detectCursorHostOs();
  const mcpLabel = formatPathForLog(mcpPath);

  const { env } = getConfig();
  const entry = buildCursorVoiceEntry(env.APP_TOKEN);

  emitLog(
    onLog,
    'check',
    'info',
    `Checking global Cursor MCP config (${mcpLabel}) on ${hostOs}…`,
  );
  emitLog(
    onLog,
    'check',
    'info',
    `User root: ${formatPathForLog(userRoot)}${
      userRoot === join(resolveUserHome(), 'Projects')
        ? ''
        : ' (no ~/Projects folder — using home)'
    }`,
  );

  let existing = readGlobalMcpFile(mcpPath);
  let action: PrepareMcpResult['action'] = 'unchanged';

  if (!existing) {
    emitLog(
      onLog,
      'install',
      'info',
      `No global mcp.json found — installing cursor-voice at ${mcpLabel}…`,
    );
    existing = { mcpServers: {} };
    action = 'installed';
  } else {
    const current = existing.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME];
    const installedVersion = current?.cursorVoice?.version ?? null;
    if (!current) {
      emitLog(
        onLog,
        'install',
        'info',
        'cursor-voice MCP server not registered globally — adding entry…',
      );
      action = 'installed';
    } else if (
      !installedVersion ||
      compareVersions(installedVersion, CURSOR_VOICE_MCP_VERSION) < 0
    ) {
      emitLog(
        onLog,
        'update',
        'info',
        installedVersion
          ? `Global MCP version ${installedVersion} is older than ${CURSOR_VOICE_MCP_VERSION} — updating…`
          : `Global MCP has no version — updating to ${CURSOR_VOICE_MCP_VERSION}…`,
      );
      action = 'updated';
    } else {
      emitLog(
        onLog,
        'check',
        'info',
        `cursor-voice global MCP server found (version ${installedVersion}).`,
      );
    }
  }

  const merged: GlobalMcpFile = {
    mcpServers: {
      ...existing.mcpServers,
      [CURSOR_VOICE_MCP_SERVER_NAME]: {
        ...existing.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME],
        ...entry,
        cursorVoice: {
          version: CURSOR_VOICE_MCP_VERSION,
          enabled: true,
        },
        disabled: false,
      },
    },
  };

  const wasDisabled =
    existing.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME]?.disabled === true ||
    existing.mcpServers[CURSOR_VOICE_MCP_SERVER_NAME]?.cursorVoice?.enabled === false;

  if (wasDisabled) {
    emitLog(onLog, 'enable', 'info', 'Enabling cursor-voice global MCP server…');
    action = action === 'unchanged' ? 'enabled' : action;
  } else if (action === 'unchanged') {
    emitLog(onLog, 'enable', 'info', 'cursor-voice global MCP server is enabled.');
  } else {
    emitLog(onLog, 'enable', 'info', 'Enabling cursor-voice global MCP server…');
  }

  try {
    writeGlobalMcpFile(mcpPath, merged);
    ensureGlobalCursorVoiceRule(onLog);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitLog(onLog, 'error', 'error', `Could not write ${mcpLabel}: ${message}`);
    return {
      ok: false,
      scope: 'global',
      mcpPath,
      userRoot,
      hostOs,
      action: 'unchanged',
      version: CURSOR_VOICE_MCP_VERSION,
      message,
    };
  }

  emitLog(
    onLog,
    'done',
    'info',
    'Global MCP ready for all projects — restart Cursor if the server list did not refresh.',
  );

  const doneMessage =
    action === 'unchanged'
      ? 'Global MCP ready — you can start voice.'
      : action === 'installed'
        ? 'Global MCP installed and enabled — you can start voice.'
        : action === 'updated'
          ? 'Global MCP updated and enabled — you can start voice.'
          : 'Global MCP enabled — you can start voice.';

  return {
    ok: true,
    scope: 'global',
    mcpPath,
    userRoot,
    hostOs,
    action,
    version: CURSOR_VOICE_MCP_VERSION,
    message: doneMessage,
  };
}
