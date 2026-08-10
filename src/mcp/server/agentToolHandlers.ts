/**
 * Agent management tool handlers for the MCP server exposed to Cursor.
 *
 * Cursor (conversational voice agent) calls these tools to observe and control
 * the full agent ecosystem: the voice loop itself, worker agents, and parallel
 * worktree workers. This is Cursor's self-management surface.
 *
 * Tool groups:
 *   Identity   — get_session_ref
 *   Agents     — list_agents, get_agent_status, get_agent_output,
 *                spawn_agent, stop_agent, inject, revert_agent
 *   Jobs       — list_jobs_history
 *   Mode       — set_mode, execute_plan
 *
 * See docs/16-mcp-server-cursor-as-brain.md § 4 (full tool surface).
 */

import { childLogger } from '../../log.js';
import {
  getActiveAgentRun,
  getActiveAgentActivity,
  isAgentBusy,
  killActiveAgent,
  killWorktreeAgent,
  getAllActiveRuns,
} from '../../executor/agentSingleton.js';
import { submitJob, getAllActiveJobSummaries, getJobsHistory } from '../../executor/jobManager.js';
import { resolveProject, getSessionState } from '../../state/registry.js';
import { getJob, getJobEvents } from '../../state/jobs.js';
import { getActiveVoiceAgent } from '../../executor/voiceAgent.js';
import { voiceTurnQueue } from './turnQueue.js';
import { revert } from '../../executor/git.js';
import { dispatchTool } from '../handlers.js';

const log = childLogger('mcp:server:agentTools');

// ── Per-session preferred spawn mode ─────────────────────────────────────
// Stores the "next spawn" mode for each MCP session. Used when spawn_agent
// is called without an explicit mode.

const preferredModeMap = new Map<string, 'agent' | 'plan' | 'ask' | 'debug'>();

// ── Types ─────────────────────────────────────────────────────────────────

export interface SessionRefResult {
  voice_run_id: string | null;
  voice_session_id: string | null;
  voice_pid: number | null;
  mcp_session_id: string | null;
  active_job_id: string | null;
  active_project: string | null;
  active_model: string;
  preferred_spawn_mode: string;
}

export interface AgentEntry {
  id: string;
  kind: string;
  pid: number;
  activity: string | null;
  busy: boolean;
  worktree?: string | null;
  started_at?: string;
  elapsed_ms?: number;
}

export interface ListAgentsResult {
  agents: AgentEntry[];
  voice_agent: {
    run_id: string;
    pid: number;
    session_id: string | null;
    project: string;
    state: string;
  } | null;
  count: number;
  /** Turns waiting in VoiceTurnQueue because the voice agent is mid-tool. */
  pending_user_turns: number;
  /** True when at least one next_voice_turn() poll is waiting. */
  voice_agent_listening: boolean;
}

export interface GetAgentStatusArgs {
  id: string;
}

export interface AgentStatusResult {
  id: string;
  found: boolean;
  kind?: string;
  pid?: number;
  activity?: string | null;
  output?: string;
  mode?: string;
  project?: string;
  prompt?: string;
  status?: string;
  elapsed_ms?: number;
  files_written?: string[];
  files_read?: string[];
  shell_commands?: string[];
  checkpoint?: string | null;
  started_at?: string;
  finished_at?: string | null;
  /** Turns waiting for next_voice_turn — call it immediately when > 0. */
  pending_user_turns?: number;
}

export interface GetAgentOutputArgs {
  id: string;
  /** Event index to start from for pagination (default 0). */
  offset?: number;
  /** Max events to return (default 20, max 50). */
  limit?: number;
}

export interface AgentOutputResult {
  id: string;
  found: boolean;
  status?: string;
  mode?: string;
  project?: string;
  prompt?: string;
  started_at?: string;
  finished_at?: string | null;
  files_written?: string[];
  files_read?: string[];
  shell_commands?: string[];
  checkpoint?: string | null;
  events?: Array<{ ts: string; kind: string; text: string | null }>;
  total_events?: number;
  summary?: string | null;
  error?: string | null;
  has_more?: boolean;
}

export interface ListJobsHistoryArgs {
  project?: string;
  limit?: number;
  status_filter?: 'all' | 'done' | 'error' | 'stopped';
}

export interface JobHistoryEntry {
  id: string;
  project: string;
  mode: string;
  prompt: string;
  status: string;
  session_id: string | null;
  summary: string | null;
  error: string | null;
  files_changed: number | null;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  checkpoint: string | null;
}

export interface SpawnAgentArgs {
  instructions: string;
  mode?: 'agent' | 'plan' | 'ask' | 'debug';
  /**
   * Run in an isolated git worktree for parallel execution.
   * Each worktree gets a unique name; multiple agents can run concurrently.
   */
  use_worktree?: boolean;
  /** Override worktree name (auto-generated if not given). */
  worktree_name?: string;
  /** Append browser snapshot workflow to the worker prompt (UI / "Browser" tasks). */
  browser?: boolean;
}

export interface SpawnAgentResult {
  job_id: string;
  status: 'running';
  project: string;
  mode: string;
  worktree?: string;
  message: string;
}

export interface StopAgentArgs {
  id: string;
}

export interface StopAgentResult {
  ok: boolean;
  message: string;
}

export interface InjectArgs {
  id: string;
  message: string;
}

export interface InjectResult {
  ok: boolean;
  delivered: boolean;
  message: string;
}

export interface SetModeArgs {
  /** Agent id (informational — mode is stored per-session, applied on next spawn). */
  id: string;
  mode: 'ask' | 'agent' | 'debug' | 'plan';
}

export interface SetModeResult {
  ok: boolean;
  message: string;
  preferred_mode: string;
}

export interface ExecutePlanArgs {
  id: string;
}

export interface ExecutePlanResult {
  ok: boolean;
  message: string;
}

export interface RevertAgentArgs {
  /** Job ID to revert to (uses that job's git checkpoint). */
  id: string;
  /**
   * Must be true for hard reset when the agent committed changes.
   * Voice agent must confirm with the user before passing true.
   */
  confirm?: boolean;
}

export interface RevertAgentResult {
  ok: boolean;
  message: string;
  reverted_to?: string;
  files?: string[];
  method?: string;
}

export interface AgentToolHandlers {
  handleGetSessionRef: () => SessionRefResult;
  handleListAgents: () => ListAgentsResult;
  handleGetAgentStatus: (args: GetAgentStatusArgs) => Promise<AgentStatusResult>;
  handleGetAgentOutput: (args: GetAgentOutputArgs) => Promise<AgentOutputResult>;
  handleListJobsHistory: (args: ListJobsHistoryArgs) => Promise<JobHistoryEntry[]>;
  handleSpawnAgent: (args: SpawnAgentArgs) => Promise<SpawnAgentResult>;
  handleStopAgent: (args: StopAgentArgs) => Promise<StopAgentResult>;
  handleInject: (args: InjectArgs) => Promise<InjectResult>;
  handleSetMode: (args: SetModeArgs) => Promise<SetModeResult>;
  handleExecutePlan: (args: ExecutePlanArgs) => Promise<ExecutePlanResult>;
  handleRevertAgent: (args: RevertAgentArgs) => Promise<RevertAgentResult>;
}

// ── Factory (session-scoped) ──────────────────────────────────────────────

/** Build agent tool handlers bound to a specific MCP session key. */
export function makeAgentHandlers(sessionKey: string): AgentToolHandlers {
  return {
    // ── Identity ──────────────────────────────────────────────────────────

    handleGetSessionRef(): SessionRefResult {
      const voice = getActiveVoiceAgent();
      const activeRun = getActiveAgentRun();
      const session = getSessionState(sessionKey);
      return {
        voice_run_id: voice?.runId ?? null,
        voice_session_id: voice?.sessionId ?? null,
        voice_pid: voice?.pid ?? null,
        mcp_session_id: voice?.mcpSessionId ?? null,
        active_job_id: activeRun?.refId ?? null,
        active_project: session.activeProject,
        active_model: session.activeModel,
        preferred_spawn_mode: preferredModeMap.get(sessionKey) ?? 'agent',
      };
    },

    // ── Agents ────────────────────────────────────────────────────────────

    handleListAgents(): ListAgentsResult {
      const allRuns = getAllActiveRuns();
      const voiceAgent = getActiveVoiceAgent();
      const activeJobSummaries = getAllActiveJobSummaries();

      // Build a deduplicated agent list — active runs from the pool + DB-backed summaries.
      const seenIds = new Set<string>();
      const agents: AgentEntry[] = [];

      for (const run of allRuns) {
        seenIds.add(run.refId);
        const dbSummary = activeJobSummaries.find((s) => s.jobId === run.refId);
        agents.push({
          id: run.refId,
          kind: run.kind,
          pid: run.pid,
          activity: run.watcher?.getActivitySummary() ?? getActiveAgentActivity(),
          busy: true,
          worktree: run.worktreeName ?? null,
          started_at: run.startedAt.toISOString(),
          elapsed_ms: Date.now() - run.startedAt.getTime(),
        });
        void dbSummary;
      }

      // Include any DB-tracked active jobs not yet in the registry (e.g. watcher lag).
      for (const s of activeJobSummaries) {
        if (!seenIds.has(s.jobId)) {
          agents.push({
            id: s.jobId,
            kind: 'job',
            pid: s.pid,
            activity: s.activity,
            busy: true,
            worktree: s.worktree ?? null,
            elapsed_ms: s.elapsedMs,
          });
        }
      }

      return {
        agents,
        voice_agent: voiceAgent
          ? {
              run_id: voiceAgent.runId,
              pid: voiceAgent.pid,
              session_id: voiceAgent.sessionId,
              project: voiceAgent.project,
              state: 'running',
            }
          : null,
        count: agents.length,
        pending_user_turns: voiceTurnQueue.size,
        voice_agent_listening: voiceTurnQueue.waitersCount > 0,
      };
    },

    async handleGetAgentStatus(args: GetAgentStatusArgs): Promise<AgentStatusResult> {
      const active = getActiveAgentRun();

      // Check active singleton.
      if (active && active.refId === args.id) {
        const summary = active.watcher?.getSummary();
        const elapsedMs = summary
          ? Date.now() - summary.startedAt.getTime()
          : undefined;
        return {
          id: args.id,
          found: true,
          kind: active.kind,
          pid: active.pid,
          activity: getActiveAgentActivity(),
          output: active.watcher?.getSummary().lastThinking?.slice(-4000),
          elapsed_ms: elapsedMs,
          files_written: summary?.filesWritten ?? [],
          files_read: summary?.filesRead ?? [],
          shell_commands: summary?.shellCommands ?? [],
          pending_user_turns: voiceTurnQueue.size,
        };
      }

      // Check worktree pool.
      const allRuns = getAllActiveRuns();
      const worktreeRun = allRuns.find((r) => r.refId === args.id && r.kind === 'worktree');
      if (worktreeRun) {
        const summary = worktreeRun.watcher?.getSummary();
        const elapsedMs = Date.now() - worktreeRun.startedAt.getTime();
        return {
          id: args.id,
          found: true,
          kind: 'worktree',
          pid: worktreeRun.pid,
          activity: worktreeRun.watcher?.getActivitySummary() ?? null,
          output: summary?.lastThinking?.slice(-4000),
          elapsed_ms: elapsedMs,
          files_written: summary?.filesWritten ?? [],
          files_read: summary?.filesRead ?? [],
          shell_commands: summary?.shellCommands ?? [],
          pending_user_turns: voiceTurnQueue.size,
        };
      }

      // Fall back to DB (completed job).
      const job = getJob(args.id);
      if (job) {
        return {
          id: args.id,
          found: true,
          kind: 'job',
          project: job.project,
          prompt: job.prompt,
          mode: job.mode,
          status: job.status,
          checkpoint: job.checkpoint,
          started_at: job.startedAt,
          finished_at: job.finishedAt,
          output: job.summary ?? job.error ?? undefined,
        };
      }

      return { id: args.id, found: false };
    },

    async handleGetAgentOutput(args: GetAgentOutputArgs): Promise<AgentOutputResult> {
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.min(50, Math.max(1, args.limit ?? 20));

      // Try active agent first (in-memory events).
      const active = getActiveAgentRun();
      const allRuns = getAllActiveRuns();
      const liveRun = [active, ...allRuns].filter(Boolean).find(
        (r) => r?.refId === args.id,
      );

      if (liveRun?.watcher) {
        const recent = liveRun.watcher.getRecentProgress(50);
        const page = recent.slice(offset, offset + limit);
        const summary = liveRun.watcher.getSummary();
        return {
          id: args.id,
          found: true,
          status: 'running',
          files_written: summary.filesWritten,
          files_read: summary.filesRead,
          shell_commands: summary.shellCommands,
          events: page,
          total_events: recent.length,
          has_more: offset + limit < recent.length,
        };
      }

      // Completed job — read from DB.
      const job = getJob(args.id);
      if (!job) return { id: args.id, found: false };

      const allEvents = getJobEvents(args.id);
      const page = allEvents.slice(offset, offset + limit);

      const filesWritten = allEvents
        .filter((e) => e.kind === 'file_write')
        .map((e) => {
          try { return (JSON.parse(e.payload ?? '{}') as { path?: string }).path ?? ''; }
          catch { return ''; }
        })
        .filter(Boolean);

      const filesRead = allEvents
        .filter((e) => e.kind === 'file_read')
        .map((e) => {
          try { return (JSON.parse(e.payload ?? '{}') as { path?: string }).path ?? ''; }
          catch { return ''; }
        })
        .filter(Boolean);

      const shellCommands = allEvents
        .filter((e) => e.kind === 'shell_run')
        .map((e) => {
          try { return (JSON.parse(e.payload ?? '{}') as { cmd?: string }).cmd ?? ''; }
          catch { return ''; }
        })
        .filter(Boolean);

      return {
        id: args.id,
        found: true,
        status: job.status,
        mode: job.mode,
        project: job.project,
        prompt: job.prompt.slice(0, 200),
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        files_written: filesWritten,
        files_read: filesRead,
        shell_commands: shellCommands,
        checkpoint: job.checkpoint,
        events: page.map((e) => ({ ts: e.ts, kind: e.kind, text: e.payload })),
        total_events: allEvents.length,
        has_more: offset + limit < allEvents.length,
        summary: job.summary,
        error: job.error,
      };
    },

    async handleListJobsHistory(args: ListJobsHistoryArgs): Promise<JobHistoryEntry[]> {
      const session = getSessionState(sessionKey);
      const project = args.project ?? session.activeProject ?? undefined;
      const limit = Math.min(30, Math.max(1, args.limit ?? 10));
      const statusFilter = args.status_filter ?? 'all';

      const jobs = getJobsHistory(project, limit, statusFilter);

      return jobs.map((j) => {
        const elapsed =
          j.finishedAt && j.startedAt
            ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()
            : null;
        const filesChanged = j.diffstat
          ? (j.diffstat.match(/\d+\s+file/)?.[0]
              ? parseInt(j.diffstat.match(/(\d+)\s+file/)?.[1] ?? '0', 10)
              : null)
          : null;
        return {
          id: j.id,
          project: j.project,
          mode: j.mode,
          prompt: j.prompt.slice(0, 120),
          status: j.status,
          session_id: j.sessionId,
          summary: j.summary?.slice(0, 300) ?? null,
          error: j.error?.slice(0, 200) ?? null,
          files_changed: filesChanged,
          started_at: j.startedAt,
          finished_at: j.finishedAt,
          elapsed_ms: elapsed,
          checkpoint: j.checkpoint,
        };
      });
    },

    async handleSpawnAgent(args: SpawnAgentArgs): Promise<SpawnAgentResult> {
      const session = getSessionState(sessionKey);
      const project = resolveProject(session.activeProject ?? '');

      if (!project) {
        throw new Error(
          'No active project set. Ask the user to select a project before spawning a worker.',
        );
      }

      // Resolve mode — explicit arg wins, then session preference, then default 'agent'.
      const rawMode = args.mode ?? preferredModeMap.get(sessionKey) ?? 'agent';
      // 'debug' mode: CLI runs as agent mode but prompt intent is debug-focused.
      const cliMode: 'agent' | 'plan' | 'ask' | 'debug' = rawMode;

      // Worktree: auto-name if not supplied.
      let worktreeName: string | undefined;
      if (args.use_worktree) {
        worktreeName =
          args.worktree_name?.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40) ??
          `worker-${Date.now()}`;
      }

      if (!worktreeName && isAgentBusy()) {
        const active = getActiveAgentRun();
        throw new Error(
          `A worker agent is already running (id: ${active?.refId}). ` +
            'Call stop_agent() first, or pass use_worktree: true to run in parallel.',
        );
      }

      const debugPrefix =
        rawMode === 'debug'
          ? 'Focus on debugging and investigation. Instrument code, run tests, and report findings. '
          : '';

      const result = await submitJob(
        project,
        sessionKey,
        debugPrefix + args.instructions,
        cliMode === 'debug' ? 'agent' : cliMode,
        worktreeName,
        args.browser,
      );

      log.info(
        {
          jobId: result.jobId,
          project: result.project,
          mode: rawMode,
          worktree: worktreeName ?? null,
          sessionKey,
        },
        'worker agent spawned via MCP',
      );

      const worktreeNote = worktreeName
        ? ` Running in isolated worktree "${worktreeName}".`
        : '';
      return {
        job_id: result.jobId,
        status: 'running',
        project: result.project,
        mode: rawMode,
        ...(worktreeName ? { worktree: worktreeName } : {}),
        message:
          `Worker started (${result.jobId}) in ${rawMode} mode.${worktreeNote} ` +
          `Call get_agent_status("${result.jobId}") or get_agent_output("${result.jobId}") for progress.`,
      };
    },

    async handleStopAgent(args: StopAgentArgs): Promise<StopAgentResult> {
      // Try singleton first.
      const active = getActiveAgentRun();
      if (active && active.refId === args.id) {
        killActiveAgent('stopped by voice command');
        log.info({ id: args.id, sessionKey }, 'singleton worker agent stopped');
        return { ok: true, message: `Agent ${args.id} stopped.` };
      }

      // Try worktree pool.
      const allRuns = getAllActiveRuns();
      const worktreeRun = allRuns.find((r) => r.refId === args.id && r.kind === 'worktree');
      if (worktreeRun) {
        killWorktreeAgent(args.id, 'stopped by voice command');
        log.info({ id: args.id, sessionKey }, 'worktree agent stopped');
        return { ok: true, message: `Worktree agent ${args.id} stopped.` };
      }

      // No active match.
      const allIds = allRuns.map((r) => r.refId).join(', ') || 'none';
      return {
        ok: false,
        message:
          `Agent "${args.id}" is not currently running. ` +
          `Active ids: [${allIds}]. Use list_agents() to verify.`,
      };
    },

    async handleInject(args: InjectArgs): Promise<InjectResult> {
      const active = getActiveAgentRun();

      if (!active || active.refId !== args.id) {
        return {
          ok: false,
          delivered: false,
          message: `Agent "${args.id}" is not the active singleton. Use list_agents() to verify.`,
        };
      }

      const handle = active.handle as { stdin?: { write?: (s: string) => void } };
      if (handle.stdin?.write) {
        try {
          handle.stdin.write(`\n${args.message}\n`);
          log.info({ id: args.id, msg: args.message.slice(0, 80), sessionKey }, 'inject delivered');
          return { ok: true, delivered: true, message: 'Message injected (best-effort).' };
        } catch (err) {
          log.warn({ err, id: args.id }, 'inject write failed');
        }
      }

      log.warn({ id: args.id, sessionKey }, 'inject not supported — agent has no stdin');
      return {
        ok: true,
        delivered: false,
        message:
          'Agent is running but stdin injection is not supported. ' +
          'If context is critical: call stop_agent() then spawn_agent() with amended instructions.',
      };
    },

    /**
     * Store the preferred spawn mode for this MCP session.
     * The mode is applied as the default on the next spawn_agent() call.
     * Does NOT restart or modify any running agent.
     */
    async handleSetMode(args: SetModeArgs): Promise<SetModeResult> {
      const mode = args.mode as 'ask' | 'agent' | 'debug' | 'plan';
      preferredModeMap.set(sessionKey, mode);

      const modeDescriptions: Record<string, string> = {
        agent: 'Agent — applies changes directly (default).',
        plan: 'Plan — proposes a plan and waits for approval before changes.',
        ask: 'Ask — read-only Q&A; no file edits.',
        debug: 'Debug — agent mode with debugging-focused prompt steering.',
      };

      log.info({ sessionKey, mode, agentId: args.id }, 'preferred spawn mode set');
      return {
        ok: true,
        preferred_mode: mode,
        message:
          `Preferred spawn mode set to "${mode}". ${modeDescriptions[mode] ?? ''} ` +
          `Next spawn_agent() call will use this mode unless overridden.`,
      };
    },

    async handleExecutePlan(args: ExecutePlanArgs): Promise<ExecutePlanResult> {
      try {
        const result = await dispatchTool(
          'cursor_submit',
          { prompt: 'Execute the proposed plan and apply the changes.' },
          sessionKey,
        );
        return {
          ok: true,
          message: `Plan execution started for agent ${args.id}. Result: ${JSON.stringify(result)}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },

    async handleRevertAgent(args: RevertAgentArgs): Promise<RevertAgentResult> {
      const job = getJob(args.id);

      if (!job) {
        return { ok: false, message: `Job "${args.id}" not found in history.` };
      }
      if (!job.checkpoint) {
        return {
          ok: false,
          message:
            `Job "${args.id}" has no git checkpoint — it may have been submitted before checkpointing ` +
            'was enabled, or the project is not a git repo.',
        };
      }

      const project = resolveProject(job.project);
      if (!project) {
        return {
          ok: false,
          message: `Project "${job.project}" from job "${args.id}" is no longer in the registry.`,
        };
      }

      try {
        const result = await revert(project.path, job.checkpoint, args.confirm ?? false);
        log.info(
          {
            jobId: args.id,
            project: job.project,
            checkpoint: job.checkpoint,
            method: result.method,
            files: result.files.length,
          },
          'agent reverted to checkpoint',
        );
        return {
          ok: true,
          message:
            `Reverted "${job.project}" to checkpoint ${job.checkpoint.slice(0, 8)}… ` +
            `using ${result.method}. ` +
            (result.files.length > 0
              ? `${result.files.length} file${result.files.length !== 1 ? 's' : ''} affected.`
              : 'Working tree was clean.'),
          reverted_to: result.revertedTo,
          files: result.files,
          method: result.method,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: msg };
      }
    },
  };
}

// ── Default handlers (legacy 'default' session key) ───────────────────────

const defaultHandlers = makeAgentHandlers('default');

export const handleListAgents = defaultHandlers.handleListAgents;
export const handleGetAgentStatus = defaultHandlers.handleGetAgentStatus;
export const handleSpawnAgent = defaultHandlers.handleSpawnAgent;
export const handleStopAgent = defaultHandlers.handleStopAgent;
export const handleInject = defaultHandlers.handleInject;
export const handleSetMode = defaultHandlers.handleSetMode;
export const handleExecutePlan = defaultHandlers.handleExecutePlan;
