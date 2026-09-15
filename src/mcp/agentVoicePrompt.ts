import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getConfig, getConfigPath } from '../config.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { MCP_SERVER_NAME } from '../providers/agents/mcpRegistration.js';
import { detectInstallMode } from '../serve/installMode.js';

/**
 * Where a prompt file might live, most specific first.
 *
 * The bridge home wins, so anyone can override a prompt by dropping their own
 * copy next to config.json. The install root is the fallback and is what makes
 * this work at all for an npm or .deb install: the home is `~/.agentvoice`,
 * the prompts ship with the package, and the two are different directories.
 *
 * Resolving only from the config directory meant every MCP `initialize` on a
 * non-clone install answered 500 — so no agent could connect, at all.
 * `import.meta.url` is not an option here: in dev the source is two levels
 * from the root and tsup bundles it flat into dist/, one level down.
 */
function promptRoots(): string[] {
  const roots = [dirname(resolve(getConfigPath()))];
  const installRoot = detectInstallMode().root;
  if (!roots.includes(installRoot)) roots.push(installRoot);
  return roots;
}

export function readAgentVoicePrompt(relativePath: string): string {
  const tried: string[] = [];
  for (const root of promptRoots()) {
    const candidate = join(root, relativePath);
    tried.push(candidate);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf-8').trim();
  }
  throw new Error(
    `AgentVoice prompt "${relativePath}" not found. Looked in:\n  ${tried.join('\n  ')}\n` +
      'A packaged install ships these under its install root; a clone has them in prompts/.',
  );
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
