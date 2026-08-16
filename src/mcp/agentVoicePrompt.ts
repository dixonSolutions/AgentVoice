import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getConfig, getConfigPath } from '../config.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { MCP_SERVER_NAME } from '../providers/agents/mcpRegistration.js';

/**
 * Returns the project root directory derived from the config file path.
 *
 * Using import.meta.url is unreliable here: in dev the source is at
 * src/mcp/agentVoicePrompt.ts (two levels from root) but tsup bundles
 * everything flat into dist/index.js (one level from root), so the climb count
 * would differ. getConfigPath() always resolves to an absolute path regardless
 * of how the process was launched or where the bundle lives.
 */
function getRepoRoot(): string {
  return dirname(resolve(getConfigPath()));
}

export function readAgentVoicePrompt(relativePath: string): string {
  return readFileSync(join(getRepoRoot(), relativePath), 'utf-8').trim();
}

/**
 * Substitute live config + active-provider identity into prompt templates.
 *
 * `{{AGENT_DISPLAY_NAME}}` is the *coding agent* the user chose (Cursor / Codex /
 * Claude Code). It is never hardcoded: the same prompt has to read correctly
 * whichever CLI is active, and the user hears this name in narration.
 * `{{MCP_SERVER_NAME}}` keeps the prompt in step with the registered server key.
 */
function applyVoicePromptVars(text: string): string {
  const ms = getConfig().settings.voice.workerPollTimeoutMs ?? 25_000;
  const agentDisplayName = getActiveProvider().displayName;
  return text
    .replaceAll('{{WORKER_POLL_TIMEOUT_MS}}', String(ms))
    .replaceAll('{{AGENT_DISPLAY_NAME}}', agentDisplayName)
    .replaceAll('{{MCP_SERVER_NAME}}', MCP_SERVER_NAME);
}

/** Server `instructions` returned on MCP initialize. */
export function agentVoiceMcpInstructions(): string {
  return applyVoicePromptVars(readAgentVoicePrompt('prompts/agentvoice/mcp-instructions.md'));
}

/** The AgentVoice system prompt — boot prompt body and CLI rule-file body. */
export function agentVoiceRuleBody(): string {
  return applyVoicePromptVars(readAgentVoicePrompt('prompts/agentvoice/system.md'));
}
