/**
 * Detect read-only questions misrouted to agent_submit.
 * Server-side guard — questions must use agent_ask (no code changes).
 */

const MUTATION_VERBS =
  /\b(build|fix|add|change|refactor|write|update|delete|remove|commit|deploy|install|migrate|rename|merge)\b/i;

/** Whole-word only — "implementation" must not match. */
const MUTATION_VERBS_STRICT =
  /\b(implement|create)\b/i;

const QUESTION_PATTERNS = [
  /\b(what|which|how|why|when|where|who)\b/i,
  /\bnext\b.*\b(steps?|milestones?|phase|priority|tasks?)\b/i,
  /\b(implementation|roadmap|plan|status|progress|done|remaining|left)\b/i,
  /\b(tell me|describe|explain|list|summarize|overview)\b/i,
  /\bget the next\b/i,
  /\basking about\b/i,
  /\basking for\b/i,
];

const READ_ONLY_INTENT =
  /\b(next implementation steps|implementation steps|what('s| is) next|roadmap|remaining work|what to (do|build) next)\b/i;

/** cursor-agent execution modes — NOT valid agent_set_model IDs. */
export const EXECUTION_MODES = new Set(['agent', 'plan', 'ask']);

export function looksLikeReadOnlyQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isReadOnlyResearchIntent(trimmed)) return true;
  if (looksLikeMutationRequest(trimmed)) return false;
  return QUESTION_PATTERNS.some((p) => p.test(trimmed));
}

/** Research / Q&A — never agent_submit even if the user says "create an agent". */
export function isReadOnlyResearchIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (READ_ONLY_INTENT.test(t)) return true;
  if (/\b(steps?|summary)\b/i.test(t) && /\b(implement|project|next)\b/i.test(t)) return true;
  return false;
}

/** Requests that write git state or files — must use agent_submit. */
export function looksLikeMutationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isReadOnlyResearchIntent(trimmed)) return false;
  if (MUTATION_VERBS.test(trimmed)) return true;
  if (MUTATION_VERBS_STRICT.test(trimmed)) return true;
  return /\bpull request\b/i.test(trimmed);
}

/** Strip voice preamble / STT junk; extract the research question for agent_ask. */
export function normalizeAskQuestion(raw: string): string {
  let t = raw.trim();
  if (!t) return t;

  t = t.replace(/\b(?:please\.?\s*)?end\.?\s*$/i, '').trim();
  t = t.replace(/\bcasa\s+hn\b/gi, 'cursor');
  t = t.replace(/\bcasa\b/gi, 'cursor');

  if (isReadOnlyResearchIntent(t)) {
    if (/\bimplementation steps\b/i.test(t) || /\bnext steps\b/i.test(t)) {
      return 'What are the next implementation steps for this project?';
    }
    if (/\broadmap\b/i.test(t)) {
      return 'What is the implementation roadmap for this project?';
    }
    if (/\bwhat('s| is) next\b/i.test(t)) {
      return "What should be implemented next on this project?";
    }
  }

  t = t.replace(
    /^(?:start[,.]?\s*)?(?:can you\s+)?(?:create|set up|setup)\s+(?:a\s+)?(?:cursor\s+)?(?:agent\s+)?(?:for me\s+)?(?:asking for\s+)?/i,
    '',
  );
  t = t.replace(/^i(?:'d| would) like you to\s+/i, '');
  t = t.trim();

  if (!t.endsWith('?')) {
    t = t.replace(/\s+(?:and give me a summary|with a summary)\.?$/i, '').trim();
  }

  return t || raw.trim();
}

/** Requests about installing/configuring the voice bridge — not the active codebase. */
export function isMetaVoiceBridgeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isReadOnlyResearchIntent(t)) return false;
  return (
    /\b(set up|setup|configure|install|run|start)\b.*\b(cursor[- ]?agent|voice bridge|voice agent|casa voice)\b/i.test(
      t,
    ) ||
    /\b(create|make)\b.*\b(cursor|casa)\b.*\bagent\b/i.test(t) ||
    /\bhow do i set up a cursor agent\b/i.test(t)
  );
}

/** True when model_id is actually a agent_submit / agent_ask execution mode. */
export function parseMisroutedExecutionMode(modelId: string): string | null {
  const normalized = modelId.toLowerCase().replace(/\s+mode$/, '').trim();
  return EXECUTION_MODES.has(normalized) ? normalized : null;
}
