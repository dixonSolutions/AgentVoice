/**
 * Normalized agent stream events.
 *
 * Every coding CLI streams a different NDJSON dialect on stdout:
 *
 *   Cursor      { type: "tool_call", subtype: "started", tool_call: { writeToolCall: {…} } }
 *   Claude Code { type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }] } }
 *   Codex       { id, msg: { type: "exec_command_begin", command: [...] } }
 *
 * Everything downstream (watcher narration, session-id capture, summary
 * extraction, ghost-agent detection) used to read Cursor's dialect directly,
 * so Claude Code and Codex produced *no* narration and never had their session
 * id captured — resume silently never worked for them.
 *
 * Providers now translate their own dialect into the events below and nothing
 * outside providers/agents/ parses raw CLI JSON.
 */

import { childLogger } from '../../log.js';

const log = childLogger('agent-events');

/** What a tool call is doing, in terms the narrator can speak. */
export type ToolAction = 'write' | 'read' | 'search' | 'shell' | 'task' | 'other';

export interface NormalizedToolCall {
  /** Tool name exactly as the CLI reported it (Write, shellToolCall, exec_command…). */
  name: string;
  action: ToolAction;
  /** File path for read/write, or the pattern for search. */
  path?: string;
  /** Shell command line for `shell` actions. */
  command?: string;
  /** Subagent type when the CLI reported a Task/subagent spawn (budget guard). */
  subagent?: string;
}

export type AgentStreamEvent =
  /** CLI reported the session/thread id — persisted so `--resume` works. */
  | { kind: 'session'; sessionId: string }
  /** Run started (first event of a run); carries the model when the CLI reports one. */
  | { kind: 'init'; model?: string }
  | { kind: 'tool_start'; tool: NormalizedToolCall }
  | { kind: 'tool_done'; tool: NormalizedToolCall; success?: boolean }
  /** Free-form assistant prose (used for the mute-agent TTS fallback). */
  | { kind: 'assistant_text'; text: string }
  /** Run finished; `text` is the final summary when the CLI provides one. */
  | { kind: 'result'; text: string | null }
  | { kind: 'error'; message: string };

// ── Shared helpers for provider parsers ───────────────────────────────────

/**
 * Map a tool name to a narratable action.
 * Deliberately name-based (not payload-based) so it works for every CLI's
 * naming style: `Write` / `writeToolCall` / `write_file` / `apply_patch`.
 */
export function classifyToolName(rawName: string): ToolAction {
  const name = rawName.toLowerCase();
  // Task/subagent first — "task" would otherwise fall through to `other`.
  if (name.includes('subagent') || /\btask\b/.test(name) || name.includes('tasktool')) return 'task';
  if (name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('apply')) {
    return 'write';
  }
  if (name.includes('glob') || name.includes('grep') || name.includes('search') || name.includes('find')) {
    return 'search';
  }
  if (name.includes('read') || name.includes('cat') || name.includes('view')) return 'read';
  if (name.includes('shell') || name.includes('bash') || name.includes('exec') || name.includes('cmd')) {
    return 'shell';
  }
  return 'other';
}

/** First non-empty string at any of the given keys. */
export function pickString(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'target_file', 'file'] as const;
export const PATTERN_KEYS = ['globPattern', 'glob_pattern', 'pattern', 'query'] as const;
export const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;

/**
 * Build a NormalizedToolCall from a tool name plus its argument object.
 * Shared by all three providers — only the *extraction* of (name, args) from
 * the raw event differs per CLI.
 */
export function normalizeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): NormalizedToolCall {
  const action = classifyToolName(name);
  const subagent = pickString(args, ['subagent_type', 'subagentType']);
  const call: NormalizedToolCall = { name, action };

  if (subagent) {
    call.subagent = subagent;
    call.action = 'task';
    return call;
  }

  if (action === 'shell') {
    const command = pickString(args, COMMAND_KEYS) ?? stringifyArgv(args?.['command']);
    if (command) call.command = command.slice(0, 200);
    return call;
  }

  if (action === 'search') {
    const pattern = pickString(args, PATTERN_KEYS);
    if (pattern) call.path = pattern;
    return call;
  }

  const path = pickString(args, PATH_KEYS);
  if (path) call.path = path;
  return call;
}

/** Codex reports commands as argv arrays (`["bash","-lc","npm test"]`). */
function stringifyArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((v): v is string => typeof v === 'string');
  if (parts.length === 0) return undefined;
  // `bash -lc "…"` — the last element is the interesting bit.
  const last = parts[parts.length - 1]!;
  return parts.length > 1 && /^(?:ba|z|d)?sh$/.test(parts[0] ?? '') ? last : parts.join(' ');
}

/**
 * Extract text from an Anthropic-style `message.content` array
 * (Claude Code and Cursor both emit this shape for assistant turns).
 */
export function extractContentText(message: unknown): string | null {
  if (typeof message === 'string') return message.trim() || null;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
    .filter((part) => part.type === undefined || part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t.trim().length > 0);
  return texts.length > 0 ? texts.join('\n').trim() : null;
}

/** Anthropic-style `tool_use` blocks inside `message.content`. */
export function extractToolUses(message: unknown): NormalizedToolCall[] {
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const calls: NormalizedToolCall[] = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const block = part as { type?: string; name?: string; input?: unknown };
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const input =
      typeof block.input === 'object' && block.input !== null
        ? (block.input as Record<string, unknown>)
        : undefined;
    calls.push(normalizeToolCall(block.name, input));
  }
  return calls;
}

/** One-time debug breadcrumb for stream shapes no provider recognised. */
export function logUnhandledEvent(provider: string, raw: Record<string, unknown>): void {
  log.debug({ provider, type: raw['type'], keys: Object.keys(raw).slice(0, 8) }, 'unhandled stream event');
}
