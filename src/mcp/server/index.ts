/**
 * MCP Streamable HTTP server — exposes every AgentVoice tool to the coding CLI.
 *
 * Each provider registers this bridge as an MCP server named `agent-voice` in
 * its own config (see providers/agents/<client>.ts). Once connected, the
 * conversational voice agent can call every tool listed below.
 *
 * Tool groups:
 *   Voice I/O    — speak, done, next_voice_turn
 *   Identity     — get_session_ref
 *   Agents       — list_agents, get_agent_status, get_agent_output,
 *                  spawn_agent, stop_agent, inject, revert_agent
 *   Jobs         — list_jobs_history
 *   Mode         — set_mode, execute_plan
 *   Project      — agent_list_projects, agent_set_project, agent_manage_projects
 *   Model        — agent_list_models, agent_set_model
 *   Execute      — agent_submit, agent_ask, agent_recall_answer
 *   Job tracking — agent_job_status, agent_job_stop
 *   Session      — agent_new_session, agent_session_info
 *   Git          — agent_diff, agent_revert
 *   System       — agent_info, agent_status
 *   MCP inspect  — agent_mcp_list, agent_mcp_tools
 *   User display — show_images
 *   User interact — request_user_input, submit_plan_for_approval
 *
 * Transport: MCP Streamable HTTP (preferred over legacy SSE).
 * Auth: same Bearer token as /api/*.
 *
 * Pre-rename `cursor_*` tool names are still accepted by dispatchTool but are
 * deliberately not advertised here — see LEGACY_TOOL_ALIASES in schemas.ts.
 *
 * See docs/16-mcp-server-agent-as-brain.md and docs/11-mcp-tool-surface.md.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { childLogger } from '../../log.js';
import { verifyWsToken } from '../../auth.js';
import {
  handleSpeak,
  handleDone,
  handleNextVoiceTurn,
  hasActiveVoiceSession,
  NO_VOICE_SESSION_ERROR,
} from './voiceToolHandlers.js';
import {
  makeAgentHandlers,
} from './agentToolHandlers.js';
import { dispatchTool } from '../handlers.js';
import { agentVoiceMcpInstructions } from '../agentVoicePrompt.js';
import { MCP_ENTRY_VERSION, MCP_SERVER_NAME } from '../../providers/agents/mcpRegistration.js';
import { bindVoiceAgentMcpSession } from '../../executor/voiceAgent.js';
import { registerRequest, type UserInputRequest, type PlanApprovalRequest } from './approvalRegistry.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { instrumentMcpToolLogging } from './toolLogging.js';
import { handleShowImages } from './imageToolHandlers.js';
import { voiceTurnQueue } from './turnQueue.js';

const log = childLogger('mcp:server');

function voiceToolResponse(result: { error?: string; message?: string; [key: string]: unknown }) {
  const text = JSON.stringify(result);
  if (result.error === 'NO_VOICE_SESSION') {
    return {
      content: [{ type: 'text' as const, text }],
      isError: true,
    };
  }
  return { content: [{ type: 'text' as const, text }] };
}

// ── MCP server factory ────────────────────────────────────────────────────

function buildMcpServer(sessionKey: string): McpServer {
  const agentTools = makeAgentHandlers(sessionKey);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_ENTRY_VERSION },
    {
      capabilities: { tools: {} },
      instructions: agentVoiceMcpInstructions(),
    },
  );

  instrumentMcpToolLogging(server);

  // ── Voice I/O ──────────────────────────────────────────────────────────

  server.tool(
    'speak',
    'Speak to the user out loud (phone/PWA voice session only). Returns error NO_VOICE_SESSION if no listener is connected. ' +
      'Call one sentence at a time for low first-audio latency. ' +
      'When no voice session is active, use normal IDE text instead.',
    { text: z.string().min(1).describe('Exact words to speak aloud. One sentence per call.') },
    async ({ text }) => {
      const result = handleSpeak({ text });
      return voiceToolResponse({ ...result });
    },
  );

  server.tool(
    'done',
    'Signal that you have finished speaking and re-arm the mic (phone/PWA voice session only). ' +
      'Returns error NO_VOICE_SESSION if no listener is connected.',
    {},
    async () => {
      const result = handleDone();
      return voiceToolResponse({ ...result });
    },
  );

  server.tool(
    'next_voice_turn',
    'Wait for the next user utterance (phone/PWA voice session only). Returns error NO_VOICE_SESSION if no listener. ' +
      'Long-polls up to timeout_ms (default 30 s). ' +
      'Returns { turn: null } on timeout — call again immediately to keep listening. ' +
      'Call done() before next_voice_turn() to re-arm the mic first. ' +
      'On TTS barge-in, tts_interrupt.last_heard_words is what the user heard aloud (~10 words). Agents keep running.',
    {
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .describe('Max wait in milliseconds (default 30 000, max 60 000).'),
    },
    async ({ timeout_ms }) => {
      const result = await handleNextVoiceTurn({ timeout_ms });
      return voiceToolResponse({ ...result });
    },
  );

  // ── Identity ───────────────────────────────────────────────────────────

  server.tool(
    'get_session_ref',
    'Get your current identity: voice agent run ID, CLI session ID (resume ref), ' +
      'MCP session ID, active job ID, active project, active model, and preferred spawn mode. ' +
      'Call this to orient yourself after a resume or when session state is unclear.',
    {},
    async () => {
      const result = agentTools.handleGetSessionRef();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Agent management ───────────────────────────────────────────────────

  server.tool(
    'list_agents',
    'Return all running worker agents (singleton + parallel worktree workers) and the voice agent. ' +
      'Shows id, kind, pid, current activity, elapsed time, and worktree name. ' +
      'Call before answering "what are you working on?" or before spawning a new worker.',
    {},
    async () => {
      const result = agentTools.handleListAgents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'get_agent_status',
    'Get live status for a specific agent: activity, files written/read, shell commands run, and elapsed time. ' +
      'For completed jobs, returns summary, error, and status from the database.',
    { id: z.string().min(1).describe('Agent or job ID from list_agents, spawn_agent, or list_jobs_history.') },
    async ({ id }) => {
      const result = await agentTools.handleGetAgentStatus({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'get_agent_output',
    'Get the full event log for an agent: tool calls, file writes, shell runs, and output text. ' +
      'Paginated — use offset/limit for large histories. ' +
      'For running agents, returns the in-memory rolling event buffer. ' +
      'For completed agents, reads from the database.',
    {
      id: z.string().min(1).describe('Agent or job ID.'),
      offset: z.number().int().min(0).optional().describe('Event index to start from (default 0).'),
      limit: z.number().int().min(1).max(50).optional().describe('Events to return (default 20, max 50).'),
    },
    async ({ id, offset, limit }) => {
      const result = await agentTools.handleGetAgentOutput({ id, offset, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'spawn_agent',
    'Start a new worker agent with the given coding instructions. ' +
      'Modes: agent (default, applies changes), plan (proposes then waits), ' +
      'ask (read-only), debug (instruments and investigates). ' +
      'Set use_worktree: true to run in an isolated git worktree alongside the current worker ' +
      '— this enables true parallel execution without working-tree conflicts. ' +
      'Speak to confirm the task with the user before spawning. Include in instructions that the worker ' +
      'must produce clear, narratable progress (files, commands, phases) for live voice updates. ' +
      "Don't start silently.",
    {
      instructions: z.string().min(1).describe("The coding task — use the user's words."),
      mode: z
        .enum(['agent', 'plan', 'ask', 'debug'])
        .optional()
        .describe(
          'agent = apply changes; plan = propose only; ask = read-only; ' +
          'debug = agent mode with debugging focus. Default: stored preference or "agent".',
        ),
      use_worktree: z
        .boolean()
        .optional()
        .describe(
          'Run in an isolated git worktree. Allows parallel agents on the same project. ' +
          'Each worktree is independent — no shared working-tree conflicts.',
        ),
      worktree_name: z
        .string()
        .optional()
        .describe('Optional worktree name (auto-generated if not set). Alphanumeric + hyphens.'),
      browser: z
        .boolean()
        .optional()
        .describe(
          'Append browser snapshot workflow — use for UI work or when the user says "Browser".',
        ),
    },
    async ({ instructions, mode, use_worktree, worktree_name, browser }) => {
      const result = await agentTools.handleSpawnAgent({
        instructions,
        mode,
        use_worktree,
        worktree_name,
        browser,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'stop_agent',
    'Terminate a specific worker agent immediately (SIGTERM → SIGKILL). ' +
      'Works for both singleton and worktree agents. Use list_agents() to get the id. ' +
      'The API rejects this unless the user explicitly issued a recent stop/cancel command.',
    { id: z.string().min(1).describe('Agent or job ID from list_agents.') },
    async ({ id }) => {
      if (hasActiveVoiceSession() && !voiceTurnQueue.checkAndClearInterrupt()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'USER_STOP_REQUIRED',
                message: 'Worker remains running — only an explicit recent user stop command can terminate it.',
              }),
            },
          ],
          isError: true,
        };
      }
      const result = await agentTools.handleStopAgent({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'inject',
    'Send additional context to a running agent (best-effort stdin write). ' +
      'If not delivered, fall back to stop_agent() + spawn_agent() with amended instructions.',
    {
      id: z.string().min(1).describe('Agent ID.'),
      message: z.string().min(1).describe('Context to inject into the running agent.'),
    },
    async ({ id, message }) => {
      const result = await agentTools.handleInject({ id, message });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'revert_agent',
    'Revert a project to the git checkpoint recorded before a specific job ran. ' +
      'Uncommitted changes: git stash (safe, reversible). ' +
      'Agent-committed changes: git reset --hard (destructive — requires confirm: true). ' +
      'Always confirm with the user before calling with confirm: true.',
    {
      id: z
        .string()
        .min(1)
        .describe('Job ID whose pre-run git checkpoint to revert to (from list_jobs_history or spawn_agent result).'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true for hard reset when the agent made commits. ' +
          'Obtain explicit user confirmation first.',
        ),
    },
    async ({ id, confirm }) => {
      const result = await agentTools.handleRevertAgent({ id, confirm });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Job history ────────────────────────────────────────────────────────

  server.tool(
    'list_jobs_history',
    'List recent jobs for the active project (or a specified project). ' +
      'Returns id, mode, prompt, status, files changed, summary, error, and timing. ' +
      'Use to find job IDs for revert_agent or get_agent_output on completed work.',
    {
      project: z.string().optional().describe('Project name (defaults to active project).'),
      limit: z.number().int().min(1).max(30).optional().describe('Max jobs to return (default 10).'),
      status_filter: z
        .enum(['all', 'done', 'error', 'stopped'])
        .optional()
        .describe('Filter by status (default: all).'),
    },
    async ({ project, limit, status_filter }) => {
      const result = await agentTools.handleListJobsHistory({ project, limit, status_filter });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Mode & execution control ───────────────────────────────────────────

  server.tool(
    'set_mode',
    'Store the preferred spawn mode for this session. ' +
      'The next spawn_agent() call will use this mode if no explicit mode is given. ' +
      'Modes: agent (default), plan (propose before apply), ask (read-only), ' +
      'debug (agent + debugging focus). ' +
      'Does NOT restart or modify any running agent.',
    {
      id: z
        .string()
        .min(1)
        .optional()
        .describe('Agent context id (informational — mode is session-scoped, not per-agent).'),
      mode: z
        .enum(['ask', 'agent', 'debug', 'plan'])
        .describe('Mode to use for the next spawn_agent call.'),
    },
    async ({ id, mode }) => {
      const result = await agentTools.handleSetMode({ id: id ?? 'session', mode });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'execute_plan',
    'Trigger execution on a plan-mode agent — submits a follow-up that applies the proposed plan.',
    {
      id: z.string().min(1).describe('Agent ID of the plan-mode session.'),
    },
    async ({ id }) => {
      const result = await agentTools.handleExecutePlan({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Project management ─────────────────────────────────────────────────

  server.tool(
    'agent_list_projects',
    'List all enabled projects in the registry. ' +
      'Returns name, description, aliases, and which is active. ' +
      'Use before agent_set_project or when the user asks "what can I work on?"',
    {
      query: z.string().optional().describe('Filter by name, alias, or description (fuzzy contains).'),
    },
    async ({ query }) => {
      const result = await dispatchTool('agent_list_projects', { query }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_set_project',
    'Set the active project for this session. Validates against the registry. ' +
      'Speak the project description back to the user so a mishear is caught before any edits.',
    {
      project: z.string().describe('Project name or alias to set as active.'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_set_project', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_manage_projects',
    'Administer allowlisted codebases: describe the project model, list/filter, add, update, or remove. ' +
      'Projects map spoken names to workspace paths; the user usually selects the active project in the PWA dropdown.',
    {
      action: z
        .enum(['describe', 'list', 'add', 'update', 'remove'])
        .describe('describe | list | add | update | remove'),
      query: z.string().optional().describe('list: filter by name, alias, or description'),
      enabled: z.boolean().optional().describe('list: filter by enabled'),
      name: z.string().optional().describe('Slug name — required for add/update/remove'),
      path: z.string().optional().describe('Absolute host path — required for add'),
      description: z.string().max(200).optional().describe('Short label'),
      aliases: z.array(z.string()).optional().describe('Spoken aliases'),
    },
    async (args) => {
      const result = await dispatchTool('agent_manage_projects', args, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Model management ───────────────────────────────────────────────────

  server.tool(
    'agent_list_models',
    'List available AI models. Returns id, displayName, and the currently active model. ' +
      'Refreshes from CLI cache (TTL-based). ' +
      'Use to find a model ID before agent_set_model.',
    {
      query: z.string().optional().describe('Filter by id or display name (e.g. "claude", "fast", "thinking").'),
    },
    async ({ query }) => {
      const result = await dispatchTool('agent_list_models', { query }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_set_model',
    'Set the AI model. Default scope is global: updates the bridge default, all active sessions, and future sessions. ' +
      'Use scope "session" only when the user explicitly says they want this session/connection only. ' +
      'Must be a valid model ID from agent_list_models.',
    {
      model_id: z.string().describe('Exact model ID (from agent_list_models, e.g. "claude-opus-4-8-thinking-high").'),
      scope: z
        .enum(['global', 'session'])
        .optional()
        .describe('global (default) = default + all sessions. session = this connection only.'),
    },
    async ({ model_id, scope }) => {
      const result = await dispatchTool('agent_set_model', { model_id, scope }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Execution ──────────────────────────────────────────────────────────

  server.tool(
    'agent_submit',
    'Submit a coding task to the active agent CLI (worker). ' +
      'Returns immediately with a job_id. Track progress with agent_job_status or get_agent_status. ' +
      'Takes a git checkpoint automatically — use revert_agent to undo if needed.',
    {
      prompt: z
        .string()
        .min(1)
        .max(32_768)
        .describe("The coding task — relay the user's intent with minimal editing."),
      project: z.string().optional().describe('Target project (defaults to active project).'),
      mode: z
        .enum(['agent', 'plan'])
        .optional()
        .describe('agent = apply changes; plan = propose only. Default: agent.'),
      browser: z
        .boolean()
        .optional()
        .describe(
          'Append browser snapshot workflow — use for UI work or when the user says "Browser".',
        ),
    },
    async ({ prompt, project, mode, browser }) => {
      const result = await dispatchTool(
        'agent_submit',
        { prompt, project, mode, browser },
        sessionKey,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_ask',
    'Ask a read-only question about the codebase. No file edits; uses --mode ask. ' +
      'One-shot; does not pollute the work session. ' +
      'Use before agent_submit when you need repo facts to draft an accurate prompt.',
    {
      question: z
        .string()
        .min(1)
        .max(32_768)
        .describe("The question — verbatim from the user or self-generated for repo research."),
      project: z.string().optional().describe('Target project (defaults to active project).'),
    },
    async ({ question, project }) => {
      const result = await dispatchTool('agent_ask', { question, project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_recall_answer',
    'Return the last agent_ask result without re-running the agent CLI. ' +
      'Use for summarize / repeat / expand follow-ups on the previous answer.',
    {
      format: z
        .enum(['brief', 'full'])
        .optional()
        .describe('brief = voice-length summary (default); full = complete text.'),
    },
    async ({ format }) => {
      const result = await dispatchTool('agent_recall_answer', { format }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Job tracking ───────────────────────────────────────────────────────

  server.tool(
    'agent_job_status',
    'Poll a running or completed job. Returns status, recent progress events, summary, ' +
      'diffstat, and session ID. Call periodically while waiting for a long job.',
    {
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe('Job UUID from agent_submit or spawn_agent (defaults to the active job).'),
    },
    async ({ job_id }) => {
      const result = await dispatchTool('agent_job_status', { job_id }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_job_stop',
    'Terminate the active agent_submit job (SIGTERM → SIGKILL). ' +
      'Does not cancel in-flight agent_ask calls — those run to completion.',
    {
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe('Job UUID (defaults to the active job for this session).'),
    },
    async ({ job_id }) => {
      const result = await dispatchTool('agent_job_stop', { job_id }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Session management ─────────────────────────────────────────────────

  server.tool(
    'agent_new_session',
    'Clear the stored resume ID for a project so the next agent_submit starts a fresh thread. ' +
      'Use when the user says "start fresh" or "new conversation".',
    {
      project: z.string().optional().describe('Project to reset (defaults to active project).'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_new_session', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_session_info',
    'Read the persisted session state for a project: resume ID, last job, last run time. ' +
      'Useful for narrating "you were last working on X twenty minutes ago".',
    {
      project: z.string().optional().describe('Project to query (defaults to active project).'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_session_info', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Git ────────────────────────────────────────────────────────────────

  server.tool(
    'agent_diff',
    'Return the current uncommitted git diff for the active project. ' +
      'diffstat is always included; set full_patch: true for the full diff text. ' +
      'Use to describe what the last agent run changed.',
    {
      project: z.string().optional().describe('Project to diff (defaults to active project).'),
      full_patch: z.boolean().optional().describe('Include full patch text (default: false, stat only).'),
    },
    async ({ project, full_patch }) => {
      const result = await dispatchTool('agent_diff', { project, full_patch }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_revert',
    'Revert uncommitted changes in the active project. ' +
      'Uncommitted: git stash (safe). Agent-committed: git reset --hard (requires confirm: true). ' +
      'Always confirm with the user before hard reset.',
    {
      project: z.string().optional().describe('Project to revert (defaults to active project).'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required for hard reset. Confirm with the user first.'),
    },
    async ({ project, confirm }) => {
      const result = await dispatchTool('agent_revert', { project, confirm }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── System ─────────────────────────────────────────────────────────────

  server.tool(
    'agent_info',
    'Get CLI version, default model, OS, and account info for the active agent provider ' +
      "(Cursor, Codex, or Claude Code). Use when the user asks 'what model are you using?'",
    {},
    async () => {
      const result = await dispatchTool('agent_info', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_status',
    'Check authentication status of the active agent provider. ' +
      'Returns authenticated, email, and provider id. Use to verify the CLI is ready before jobs.',
    {},
    async () => {
      const result = await dispatchTool('agent_status', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );


  // ── MCP inspect ────────────────────────────────────────────────────────

  server.tool(
    'agent_mcp_list',
    'List MCP servers the Cursor CLI has configured, and their load status. Cursor-only diagnostic. ' +
      'Informational — shows what MCPs the worker agents can use.',
    {},
    async () => {
      const result = await dispatchTool('agent_mcp_list', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_mcp_tools',
    'List tools exposed by a specific executor MCP server. ' +
      'Use to discover what tools are available to worker agents from a given server.',
    {
      server: z.string().describe('MCP server identifier from agent_mcp_list.'),
    },
    async ({ server }) => {
      const result = await dispatchTool('agent_mcp_tools', { server }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── User display ─────────────────────────────────────────────────────────

  server.tool(
    'show_images',
    'Push images to the user\'s phone as a browsable carousel (non-blocking). ' +
      'Use after browser snapshots or when the user needs to see UI. ' +
      'Each item needs exactly one of path (local file), url (http/https), or data (base64). ' +
      'A new call replaces the previous carousel. ' +
      'Speak a short line like "I\'m showing that on your phone now." then call this tool.',
    {
      images: z
        .array(
          z
            .object({
              path: z.string().min(1).optional().describe('Local file path under project or temp'),
              url: z.string().min(1).optional().describe('http(s) URL loaded directly by PWA'),
              data: z.string().min(1).optional().describe('Base64 or data-URI payload'),
              mime: z.string().optional().describe('MIME type when not auto-detected'),
              caption: z.string().max(500).optional().describe('Per-image caption'),
            })
            .refine(
              (item) =>
                [item.path, item.url, item.data].filter((v) => v != null && v !== '').length === 1,
              { message: 'Each image must have exactly one of path, url, or data' },
            ),
        )
        .min(1)
        .max(10)
        .describe('Images to display — overwrites any previous carousel'),
      duration_ms: z
        .number()
        .int()
        .min(3000)
        .max(120_000)
        .optional()
        .describe('Expanded display time before minimizing to toggle (default 8000 ms)'),
      caption: z
        .string()
        .max(300)
        .optional()
        .describe('Optional title above the carousel'),
    },
    async (args) => {
      if (!hasActiveVoiceSession()) {
        return voiceToolResponse({
          ok: false,
          error: 'NO_VOICE_SESSION',
          message: NO_VOICE_SESSION_ERROR,
        });
      }
      const result = handleShowImages(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── User interaction (approvals & questions) ───────────────────────────

  server.tool(
    'request_user_input',
    'Ask the user a question and wait for their spoken or tapped reply. ' +
      'The PWA shows a prompt card; the user answers by voice or tap. ' +
      'This tool BLOCKS until the user responds, a new voice/text turn arrives, or timeout_ms elapses. ' +
      'If the user speaks/types while waiting, returns { interrupted: true, user_turn } instead of an answer — treat that as the new request. ' +
      'Use for yes/no decisions, short choices, or free-text clarifications. ' +
      'Do NOT call speak() before this — the PWA card is the notification.',
    {
      question: z.string().min(1).max(1000).describe('The question to display and read aloud to the user.'),
      input_type: z
        .enum(['yesno', 'choice', 'freetext'])
        .describe(
          'yesno = Yes / No buttons; ' +
          'choice = pick from provided options list; ' +
          'freetext = user types or speaks a free answer.',
        ),
      options: z
        .array(z.string().min(1).max(200))
        .min(2)
        .max(10)
        .optional()
        .describe('Required when input_type is "choice". List of options for the user to pick from.'),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(300_000)
        .optional()
        .describe('How long to wait for a response (default 120 000 ms = 2 min).'),
    },
    async ({ question, input_type, options, timeout_ms }) => {
      if (!hasActiveVoiceSession()) {
        return voiceToolResponse({
          error: 'NO_VOICE_SESSION',
          message: NO_VOICE_SESSION_ERROR,
        });
      }
      const timeout = timeout_ms ?? 120_000;

      const { request_id, promise } = registerRequest((id) => {
        const req: UserInputRequest = {
          kind: 'user_input',
          request_id: id,
          question,
          input_type,
          options,
        };
        void notifyPhone({ type: 'user_input_request', ...req });
        return req;
      }, timeout);

      log.info({ request_id, input_type }, 'request_user_input: waiting for user');

      try {
        const response = await promise;
        if (response.kind === 'interrupted_by_voice_turn') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  interrupted: true,
                  request_id,
                  user_turn: response.user_turn,
                  is_interrupt: response.is_interrupt,
                  received_at: response.received_at,
                  tts_interrupt: response.tts_interrupt ?? null,
                  pending_user_turns: 0,
                  message:
                    'User sent a new turn while this question was open. Act on user_turn; do not expect an answer to the original question.',
                }),
              },
            ],
          };
        }
        if (response.kind !== 'user_input') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unexpected response kind' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, answer: response.answer }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, error: message }) }] };
      }
    },
  );

  server.tool(
    'submit_plan_for_approval',
    'Present a numbered plan to the user and wait for them to approve, reject, or request modifications. ' +
      'The PWA shows a structured plan card with step-by-step detail — a core hands-free UX feature. ' +
      'This tool BLOCKS until the user responds, a new voice/text turn arrives, or timeout_ms elapses. ' +
      'If the user speaks/types while waiting, returns { interrupted: true, user_turn } instead of a decision — treat that as the new request (do not proceed with the plan). ' +
      'Always use this before applying significant, multi-file, or irreversible changes. ' +
      'Speak first: tell the user the plan is on their phone and summarize it in one sentence, then call this tool.',
    {
      title: z.string().min(1).max(200).describe('Short title summarising the plan (e.g. "Refactor auth module").'),
      steps: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe('Ordered list of concrete steps the agent will take.'),
      estimated_impact: z
        .string()
        .max(300)
        .optional()
        .describe('Optional short description of scope / risk (e.g. "Touches 4 files, no DB changes").'),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(600_000)
        .optional()
        .describe('How long to wait for a response (default 180 000 ms = 3 min).'),
    },
    async ({ title, steps, estimated_impact, timeout_ms }) => {
      if (!hasActiveVoiceSession()) {
        return voiceToolResponse({
          error: 'NO_VOICE_SESSION',
          message: NO_VOICE_SESSION_ERROR,
        });
      }
      const timeout = timeout_ms ?? 180_000;

      const { request_id, promise } = registerRequest((id) => {
        const req: PlanApprovalRequest = {
          kind: 'plan_approval',
          request_id: id,
          title,
          steps,
          estimated_impact,
        };
        void notifyPhone({ type: 'plan_approval_request', ...req });
        return req;
      }, timeout);

      log.info({ request_id, steps: steps.length }, 'submit_plan_for_approval: waiting for user');

      try {
        const response = await promise;
        if (response.kind === 'interrupted_by_voice_turn') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  interrupted: true,
                  request_id,
                  user_turn: response.user_turn,
                  is_interrupt: response.is_interrupt,
                  received_at: response.received_at,
                  tts_interrupt: response.tts_interrupt ?? null,
                  pending_user_turns: 0,
                  message:
                    'User sent a new turn while this plan was awaiting approval. Do not execute the plan; act on user_turn.',
                }),
              },
            ],
          };
        }
        if (response.kind !== 'plan_approval') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unexpected response kind' }) }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                request_id,
                decision: response.decision,
                notes: response.notes ?? null,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, error: message }) }] };
      }
    },
  );

  return server;
}

// ── Fastify route registration ────────────────────────────────────────────

/**
 * Per-connection transport map: Mcp-Session-Id → transport.
 * Stateful mode: one transport per Cursor session.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

function requireMcpAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = extractBearerToken(req);
  if (!verifyWsToken(token)) {
    void reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Register the MCP Streamable HTTP routes on the Fastify instance.
 *
 * Protocol (Streamable HTTP):
 *   POST /mcp  (no session)    → initialize → responds with Mcp-Session-Id header
 *   GET  /mcp  (session header) → open SSE stream on the existing transport
 *   POST /mcp  (session header) → JSON-RPC tool calls on the existing transport
 *   DELETE /mcp (session header) → tear down session
 *
 * Every request requires Bearer token auth.
 */
export function registerMcpServer(app: FastifyInstance): void {
  // GET /mcp — open SSE stream on an already-initialized session.
  app.get('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];

    if (typeof sessionId !== 'string') {
      log.warn('mcp GET — missing Mcp-Session-Id header');
      void reply.code(400).send({
        error: 'Missing Mcp-Session-Id header. POST to /mcp first to initialize a session.',
      });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      log.warn({ sessionId }, 'mcp GET — session not found');
      void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
      return;
    }

    log.debug({ sessionId }, 'mcp GET — opening SSE stream');
    await transport.handleRequest(req.raw, reply.raw, undefined);
  });

  // POST /mcp — initialize (no session) or tool-call dispatch (with session).
  app.post(
    '/mcp',
    { config: { rawBody: true } },
    async (req, reply) => {
      if (!requireMcpAuth(req, reply)) return;

      const sessionId = req.headers['mcp-session-id'];

      if (typeof sessionId === 'string') {
        const transport = transports.get(sessionId);
        if (!transport) {
          log.warn({ sessionId }, 'mcp POST — session not found');
          void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
          return;
        }
        await transport.handleRequest(req.raw, reply.raw, req.body);
        return;
      }

      // No session header → initialize new session.
      log.debug('mcp POST — initializing new session');
      const newId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
      });

      transports.set(newId, transport);
      transport.onclose = () => {
        transports.delete(newId);
        log.info({ sessionId: newId }, 'mcp session closed');
      };

      bindVoiceAgentMcpSession(newId);

      const mcpServer = buildMcpServer(newId);
      await mcpServer.connect(transport);
      log.info({ sessionId: newId }, 'mcp session initialized');

      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  );

  // DELETE /mcp — explicit session teardown.
  app.delete('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.close();
        transports.delete(sessionId);
        log.info({ sessionId }, 'mcp session deleted');
      }
    }
    await reply.code(204).send();
  });

  log.info('mcp server registered at /mcp (37 tools)');
}
