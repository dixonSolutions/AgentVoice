/**
 * Standing instructions prepended to worker prompts, for every agent CLI.
 * Keep minimal — the coding agent handles the work; we only pass the user's
 * words through.
 */

/** Submit jobs — block budget-burning Task/subagent spawns (watcher enforces too). */
export const AGENT_GUARDRAILS = `Do not use the Task tool or spawn subagents. Work in this session only.

USER REQUEST:`;

/** Ask — pass the question through; no extra rules for the agent. */
export const ASK_GUARDRAILS = `QUESTION:`;

/** Appended when browser flag is set — worker captures UI for the voice agent to show_images. */
export const BROWSER_SNAPSHOT_BLOCK = `
BROWSER WORKFLOW (active):
The user reviews UI on their phone. Use browser tools to navigate, interact, and take snapshots.
After each meaningful visual change, save a screenshot and list every file path in your final summary under a "Screenshots:" section (one path per line).
The voice agent will push those paths to the user with show_images — paths must be readable local files under the project or temp directory.
`;

export interface BuildAgentPromptOptions {
  browser?: boolean;
}

export function buildAgentPrompt(userPrompt: string, options?: BuildAgentPromptOptions): string {
  const trimmed = userPrompt.trim();
  const browserBlock = options?.browser ? BROWSER_SNAPSHOT_BLOCK : '';
  return `${AGENT_GUARDRAILS}${browserBlock}\n\n${trimmed}`;
}

export function buildAskPrompt(question: string): string {
  return `${ASK_GUARDRAILS}\n\n${question.trim()}`;
}
