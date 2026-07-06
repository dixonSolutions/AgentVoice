/**
 * Provider function-tool definitions.
 *
 * Generates the OpenAI function-tool JSON array that gets baked into the
 * ephemeral token request (session config). The voice model sees this as
 * its full capability set — the MCP safety boundary is enforced server-side
 * regardless of what the provider sends.
 *
 * These are defined from the same source as the zod schemas (DRY). When a
 * tool changes in schemas.ts, update the matching entry here.
 *
 * Full tool specs: docs/11-mcp-tool-surface.md
 */

// ── OpenAI function-tool shape ────────────────────────────────────────────

export interface FunctionToolParam {
  type: 'string' | 'boolean' | 'number';
  description?: string;
  enum?: string[];
}

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, FunctionToolParam>;
    required: string[];
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────

export const FUNCTION_TOOLS: FunctionTool[] = [
  // ── Project ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_list_projects',
    description:
      'Messenger only: list project names for routing when the user\'s project name is unclear. Do NOT use this to answer questions about what a project does — ask Cursor instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter term (name, alias, or description)' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_set_project',
    description:
      'Set the sticky active project for this session (which codebase cursor-agent opens). ' +
      'The user normally picks a project in the PWA dropdown before voice; use this when they ask to switch by name.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or alias' },
      },
      required: ['project'],
    },
  },
  {
    type: 'function',
    name: 'cursor_manage_projects',
    description:
      'Administer the project registry (allowlisted codebases). ' +
      'action=describe explains what projects are; list filters by query/enabled; add/update/remove mutate config.json. ' +
      'Paths must live under ~/Projects. Never expose paths to the phone user — names and descriptions only.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['describe', 'list', 'add', 'update', 'remove'],
          description: 'describe | list | add | update | remove',
        },
        query: { type: 'string', description: 'list: filter by name, alias, or description' },
        enabled: { type: 'boolean', description: 'list: filter by enabled flag' },
        name: { type: 'string', description: 'Slug (a-z0-9_-) — required for add/update/remove' },
        path: { type: 'string', description: 'Absolute path under ~/Projects — required for add' },
        description: { type: 'string', description: 'Short label shown in the app' },
      },
      required: ['action'],
    },
  },

  // ── Model ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_list_models',
    description:
      'List AI model IDs (Claude, GPT, etc.) for cursor-agent — NOT execution modes. agent/plan/ask are modes on cursor_submit, not models here.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by model id or display name' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_set_model',
    description:
      'Set the AI model (e.g. claude-opus, gpt-5, auto). NEVER pass agent/plan/ask — those are cursor_submit modes, not model IDs. Call cursor_list_models first.',
    parameters: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Exact AI model ID from cursor_list_models (e.g. auto, claude-...). NOT agent/plan/ask.',
        },
      },
      required: ['model_id'],
    },
  },

  // ── Execute ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_submit',
    description:
      'Send a coding task to Cursor. Pass the user\'s words as-is — do not rewrite. Use for build/fix/implement/change requests.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: "The user's exact request — do not rewrite or expand.",
        },
        project: {
          type: 'string',
          description: 'Target project (omit to use the active project)',
        },
        mode: {
          type: 'string',
          enum: ['agent', 'plan'],
          description:
            'Execution mode (NOT the AI model): agent = apply changes; plan = propose only. Default agent. Set AI model via cursor_set_model separately.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    type: 'function',
    name: 'cursor_ask',
    description:
      'Send a question to Cursor. Pass the user\'s words as-is. Read-only. Call once and wait for the answer — do not retry while it runs.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The user's question, verbatim" },
        project: {
          type: 'string',
          description: 'Target project (omit to use the active project)',
        },
      },
      required: ['question'],
    },
  },
  {
    type: 'function',
    name: 'cursor_recall_answer',
    description:
      'Return the last cursor_ask answer without re-querying Cursor. Use when the user asks to summarize, repeat, or expand the previous answer.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['brief', 'full'],
          description: 'brief for voice summary (default); full for complete text',
        },
      },
      required: [],
    },
  },

  // ── Job ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_status',
    description:
      'Live progress while Cursor is working — safe to call during cursor_ask (runs immediately, does not wait for ask to finish). ' +
      'Call at most once every 20 seconds while waiting. Read the activity field aloud to the user.',
    parameters: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'Job ID (optional — defaults to the active running job)',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_stop',
    description:
      'Cancel a background write job ONLY when the user explicitly says cancel/stop the job or task. NEVER because Cursor is slow. NEVER for wake phrase "cursor stop".',
    parameters: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'Job ID (optional — defaults to the active running job)',
        },
      },
      required: [],
    },
  },

  // ── Session ───────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_new_session',
    description:
      'Start a fresh cursor-agent thread for a project. Use when the user wants to start over — never while cursor_ask is pending or Cursor is busy.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_session_info',
    description:
      'Get the current session state for a project: resume ID, last job, last run time. Use to narrate "you were last working on X N minutes ago".',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
      },
      required: [],
    },
  },

  // ── Git ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_diff',
    description:
      'Show the current uncommitted changes in the project. Returns a summary stat and optionally the full patch. Use when the user asks "what changed?" or "show me the diff".',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
        full_patch: {
          type: 'boolean',
          description: 'Include the full diff text (default: false, stat only)',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'cursor_revert',
    description:
      'Undo all changes made by the last cursor-agent job. For uncommitted changes: safe stash (reversible). For committed changes: hard reset (destructive — confirm with the user first, then set confirm=true).',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project (omit for active project)' },
        confirm: {
          type: 'boolean',
          description: 'Required true for destructive hard-reset. Get explicit user confirmation first.',
        },
      },
      required: [],
    },
  },

  // ── System ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_agent_info',
    description:
      'Get cursor-agent version, model, and system info. Use when the user asks "what version is Cursor?" or for diagnostics.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cursor_agent_status',
    description: 'Check if cursor-agent is authenticated. Returns auth status and account email.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ── MCP Inspect ───────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cursor_mcp_list',
    description: "List MCP servers configured in cursor-agent's .cursor/mcp.json (for debugging).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cursor_mcp_tools',
    description: 'List tools for a specific cursor-agent MCP server (for debugging).',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server identifier from cursor_mcp_list' },
      },
      required: ['server'],
    },
  },
];

/** Build a lookup map by tool name. */
export const FUNCTION_TOOL_MAP = new Map(FUNCTION_TOOLS.map((t) => [t.name, t]));

/** Voice session tools — project is chosen in the app UI, not by the model. */
const VOICE_EXCLUDED_TOOLS = new Set([
  'cursor_set_project',
  'cursor_list_projects',
  'cursor_manage_projects',
  /** Session metadata only — voice should use cursor_ask / cursor_status instead. */
  'cursor_session_info',
  'cursor_new_session',
]);

export const VOICE_FUNCTION_TOOLS = FUNCTION_TOOLS.filter(
  (t) => !VOICE_EXCLUDED_TOOLS.has(t.name),
);
