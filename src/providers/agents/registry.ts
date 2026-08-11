/**
 * AgentProvider registry — one lookup table, keyed by the config's
 * `settings.agentClient`. This is the single seam the rest of the app uses;
 * adding a new CLI means adding one file + one map entry here.
 */

import { getConfig, type AgentClient, AGENT_CLIENTS } from '../../config.js';
import { cursorProvider } from './cursor.js';
import { codexProvider } from './codex.js';
import { claudeProvider } from './claude.js';
import type { AgentProvider } from './types.js';

const PROVIDERS: Record<AgentClient, AgentProvider> = {
  cursor: cursorProvider,
  codex: codexProvider,
  'claude-code': claudeProvider,
};

export function getProvider(client: AgentClient): AgentProvider {
  return PROVIDERS[client];
}

/** The provider for the currently configured agent client. */
export function getActiveProvider(): AgentProvider {
  return PROVIDERS[getConfig().settings.agentClient];
}

export function listAgentProviders(): AgentProvider[] {
  return AGENT_CLIENTS.map((id) => PROVIDERS[id]);
}
