import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getConfigPath, getConfig } from '../config.js';

/**
 * Returns the project root directory derived from the config file path.
 *
 * Using import.meta.url is unreliable here: in dev the source is at
 * src/mcp/loadCursorVoicePrompt.ts (two levels from root) but tsup bundles
 * everything flat into dist/index.js (one level from root), so the climb count
 * would differ. getConfigPath() always resolves to an absolute path regardless
 * of how the process was launched or where the bundle lives.
 */
function getRepoRoot(): string {
  return dirname(resolve(getConfigPath()));
}

export function readCursorVoicePrompt(relativePath: string): string {
  return readFileSync(join(getRepoRoot(), relativePath), 'utf-8').trim();
}

export function cursorVoiceMcpInstructions(): string {
  return readCursorVoicePrompt('prompts/cursor-voice/mcp-instructions.md');
}

export function cursorVoiceRuleBody(): string {
  const { systemPromptFile } = getConfig().settings;
  if (systemPromptFile) {
    const repoRoot = getRepoRoot();
    const absolutePath = resolve(repoRoot, systemPromptFile);
    return readFileSync(absolutePath, 'utf-8').trim();
  }
  return readCursorVoicePrompt('prompts/cursor-voice/system.md');
}
