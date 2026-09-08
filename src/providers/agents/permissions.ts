/**
 * Permission-mode resolution — which approval policy each agent CLI runs with.
 *
 * Every provider declares its own modes (`provider.permissionModes()`), with
 * run-everything first. The user's choice lives in
 * `settings.permissionModes[<client>]`; anything unset or unknown falls back to
 * the provider's run-everything entry, which is what AgentVoice always did.
 *
 * Modes whose `prompts` is `phone` rely on the `approve_permission` MCP tool:
 * Claude Code is launched with `--permission-prompt-tool mcp__agent-voice__approve_permission`
 * and calls it for every action its permission mode would ask about — the
 * bridge relays that to the phone (see mcp/server/index.ts).
 */

import { getConfig, type AgentClient } from '../../config.js';
import { readConfigFile, writeConfigFile } from '../../state/configFile.js';
import { childLogger } from '../../log.js';
import { getActiveProvider, getProvider } from './registry.js';
import { MCP_SERVER_NAME } from './mcpRegistration.js';
import type { AgentProvider, PermissionModeDescriptor } from './types.js';

const log = childLogger('permissions');

/** MCP tool name Claude Code calls for permission prompts. */
export const PERMISSION_PROMPT_TOOL = 'approve_permission';
/** Fully-qualified form for `--permission-prompt-tool`. */
export const PERMISSION_PROMPT_TOOL_REF = `mcp__${MCP_SERVER_NAME}__${PERMISSION_PROMPT_TOOL}`;

export function defaultPermissionMode(provider: AgentProvider): PermissionModeDescriptor {
  const modes = provider.permissionModes();
  const yolo = modes.find((m) => m.yolo);
  const first = yolo ?? modes[0];
  if (!first) throw new Error(`${provider.displayName} declares no permission modes`);
  return first;
}

/** The mode the given provider currently runs with (configured, else run-everything). */
export function activePermissionMode(provider: AgentProvider): PermissionModeDescriptor {
  const configured = getConfig().settings.permissionModes[provider.id];
  const match = configured ? provider.permissionModes().find((m) => m.id === configured) : undefined;
  if (configured && !match) {
    log.warn({ provider: provider.id, configured }, 'unknown permission mode in config — using default');
  }
  return match ?? defaultPermissionMode(provider);
}

export interface PermissionModesView {
  provider: AgentClient;
  displayName: string;
  active: PermissionModeDescriptor;
  modes: PermissionModeDescriptor[];
}

export function describePermissionModes(client?: AgentClient): PermissionModesView {
  const provider = client ? getProvider(client) : getActiveProvider();
  return {
    provider: provider.id,
    displayName: provider.displayName,
    active: activePermissionMode(provider),
    modes: [...provider.permissionModes()],
  };
}

/** Persist a mode for the active (or given) provider; throws on an unknown id. */
export function setPermissionMode(modeId: string, client?: AgentClient): PermissionModesView {
  const provider = client ? getProvider(client) : getActiveProvider();
  const wanted = modeId.trim().toLowerCase();
  const match = provider.permissionModes().find((m) => m.id.toLowerCase() === wanted);
  if (!match) {
    throw new Error(
      `${provider.displayName} has no permission mode "${modeId}". ` +
        `Available: ${provider.permissionModes().map((m) => m.id).join(', ')}.`,
    );
  }
  const cfg = readConfigFile();
  cfg.settings.permissionModes = { ...cfg.settings.permissionModes, [provider.id]: match.id };
  writeConfigFile(cfg);
  log.info({ provider: provider.id, mode: match.id }, 'permission mode set');
  return describePermissionModes(provider.id);
}
