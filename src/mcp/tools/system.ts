/**
 * System tools — cursor_agent_info, cursor_agent_status (and their generic
 * agent_info / agent_status aliases).
 *
 * Backed by the active AgentProvider's getAbout()/checkAuth() — works for
 * Cursor, Codex, and Claude Code, not just cursor-agent.
 */

import { childLogger } from '../../log.js';
import { getActiveProvider } from '../../providers/agents/registry.js';

const log = childLogger('tool:system');

// ── cursor_agent_info / agent_info ────────────────────────────────────────

export interface AgentInfoResult {
  provider: string;
  displayName: string;
  cliVersion: string;
  model: string;
  osPlatform: string;
  osArch: string;
}

/** Wraps the active provider's `getAbout()` (version/model probe), if it has one. */
export async function handleCursorAgentInfo(): Promise<AgentInfoResult> {
  const provider = getActiveProvider();
  const about = provider.getAbout ? await provider.getAbout() : null;
  if (!about) {
    log.debug({ provider: provider.id }, 'provider has no about/version probe');
  }
  return {
    provider: provider.id,
    displayName: provider.displayName,
    cliVersion: about?.cliVersion ?? 'unknown',
    model: about?.model ?? 'unknown',
    osPlatform: about?.osPlatform ?? 'unknown',
    osArch: about?.osArch ?? 'unknown',
  };
}

// ── cursor_agent_status / agent_status ────────────────────────────────────

export interface AgentStatusResult {
  provider: string;
  displayName: string;
  authenticated: boolean;
  email: string | null;
  firstName: string | null;
}

/** Wraps the active provider's `checkAuth()`. */
export async function handleCursorAgentStatus(): Promise<AgentStatusResult> {
  const provider = getActiveProvider();
  const status = await provider.checkAuth();
  return {
    provider: provider.id,
    displayName: provider.displayName,
    authenticated: status.authenticated,
    email: status.email,
    firstName: null,
  };
}
