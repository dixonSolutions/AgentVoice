/**
 * System prompt assembly for the llm_intelligence orchestrator.
 *
 * Prompt text is inlined here — editable prompt files under prompts/ are
 * reserved for the agent_native workflow only.
 */

import { listProjects, getSessionState } from '../state/registry.js';
import { getWakeWordsFromConfig } from '../voice/wakeWordsConfig.js';
import { getConfig } from '../config.js';

const INLINE_ACTIVATION_RULES = `## Activation rules

- You are **inactive** until the user says **"{{WAKE_START}}"** (from config).
- After **"{{WAKE_START}}"**, you are **active** — listen and respond until the user taps the orb to hang up.
- While active, **always respond** if the user speaks (even while Cursor is working).
- While **inactive**, do **not** call \`speak\` or tools. Wait silently.
- **No spoken phrase ends the call** — only the user tapping the orb disconnects.`;

const INLINE_ORCHESTRATOR_TEMPLATE = `You are the **voice orchestrator** for AgentVoice — an intelligence-first coding assistant.

The user **cannot see the screen**. You must **speak out loud** using the \`speak\` tool whenever you communicate.
You do not know the codebase — **Cursor** (cursor-agent CLI) does. Never guess or hallucinate repo facts.

**Active project:** {{ACTIVE_PROJECT}}

{{USER_CONTEXT}}

{{ACTIVATION_RULES}}

## Projects

{{PROJECT_CATALOG}}`;

function applyWakeWordPlaceholders(text: string, start: string): string {
  return text.replaceAll('{{WAKE_START}}', start);
}

function buildActiveProjectBlock(): string {
  const { activeProject } = getSessionState('default');
  if (!activeProject) {
    return (
      '**None selected** — tell the user to pick a project in the dropdown above the orb, ' +
      'then tap the orb to start a new session.'
    );
  }

  const meta = listProjects().find((p) => p.name === activeProject);
  const desc = meta?.description ? ` — ${meta.description}` : '';
  const aliases =
    meta && meta.aliases.length > 0 ? ` (speech aliases: ${meta.aliases.join(', ')})` : '';
  return `**${activeProject}**${desc}${aliases}`;
}

function buildProjectCatalog(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No projects are currently registered.';

  return projects
    .map((p) => {
      const aliases = p.aliases.length > 0 ? ` (also: ${p.aliases.join(', ')})` : '';
      return `  • **${p.name}**${aliases}`;
    })
    .join('\n');
}

function buildUserContextBlock(): string {
  const { userName } = getConfig().settings;
  if (!userName) return '';
  return `**User:** Address the user as **${userName}** throughout the conversation.`;
}

/** Full orchestrator system prompt with placeholders resolved. */
export function buildIntelligenceSystemPrompt(): string {
  const { start } = getWakeWordsFromConfig();
  const activationBlock = applyWakeWordPlaceholders(INLINE_ACTIVATION_RULES, start);
  const userContextBlock = buildUserContextBlock();

  return applyWakeWordPlaceholders(
    INLINE_ORCHESTRATOR_TEMPLATE.replace('{{ACTIVATION_RULES}}', activationBlock)
      .replace('{{ACTIVE_PROJECT}}', buildActiveProjectBlock())
      .replace('{{USER_CONTEXT}}\n\n', userContextBlock ? `${userContextBlock}\n\n` : '')
      .replace('{{USER_CONTEXT}}', userContextBlock)
      .replace('{{PROJECT_CATALOG}}', buildProjectCatalog()),
    start,
  );
}
