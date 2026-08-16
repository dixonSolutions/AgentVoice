/**
 * Agent stream watcher & narration classifier.
 *
 * Receives *normalized* agent events (providers/agents/events.ts) rather than
 * raw CLI JSON, so narration works identically for Cursor, Codex and Claude
 * Code. Responsibilities:
 *   1. Turn normalized events into typed NarrationEvent kinds.
 *   2. Maintain a rolling JobSummary (accumulated across the run).
 *   3. Emit NarrationEvents with cadence limiting (max 1 per 15 s for ticks;
 *      significant transitions always emit immediately).
 *
 * See docs/12-stream-json-watcher.md for the full spec.
 */

import { getConfig } from '../config.js';
import { addJobEvent } from '../state/jobs.js';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import type { AgentStreamEvent, NormalizedToolCall } from '../providers/agents/events.js';

const log = childLogger('watcher');

export type { AgentStreamEvent };

/**
 * @deprecated Raw CLI JSON no longer reaches this module — providers parse it.
 * Kept as the transport type for one raw stdout line.
 */
export type StreamJsonEvent = Record<string, unknown>;

// ── NarrationEvent ────────────────────────────────────────────────────────

export type NarrationKind =
  | 'job_started'
  | 'file_write'
  | 'file_read'
  | 'shell_run'
  | 'progress_tick'
  | 'job_done'
  | 'job_error'
  | 'ghost_killed';

export interface NarrationEvent {
  kind: NarrationKind;
  text: string;
  jobId: string;
  ts: Date;
}

// ── JobSummary ────────────────────────────────────────────────────────────

export interface JobSummary {
  filesRead: string[];
  filesWritten: string[];
  shellCommands: string[];
  lastThinking: string | null;
  elapsedMs: number;
  startedAt: Date;
}

// ── Narration labels ──────────────────────────────────────────────────────

/** One human-readable phrase describing what a tool call is doing. */
function describeToolCall(tool: NormalizedToolCall): string {
  switch (tool.action) {
    case 'write':
      return tool.path ? `wrote ${tool.path}` : 'wrote a file';
    case 'read':
      return tool.path ? `reading ${tool.path}` : 'reading a file';
    case 'search':
      return tool.path ? `searching ${tool.path}` : 'searching the codebase';
    case 'shell':
      return tool.command ? `ran: ${tool.command.slice(0, 60)}` : 'ran a command';
    case 'task':
      return `spawning ${tool.subagent ?? 'a subagent'}`;
    default:
      return 'called a tool';
  }
}

/**
 * Detect Task/subagent spawns — the budget-burning "ghost agent" pattern.
 * Providers already flag these as `action: 'task'`, so this is a single check
 * rather than per-CLI key sniffing.
 */
export function isGhostToolCall(tool: NormalizedToolCall): {
  ghost: boolean;
  reason: string | null;
} {
  if (tool.action === 'task') {
    return { ghost: true, reason: tool.subagent ?? tool.name };
  }
  return { ghost: false, reason: null };
}

// ── Watcher ───────────────────────────────────────────────────────────────

export class Watcher {
  private readonly jobId: string;
  private readonly projectName: string;
  private readonly onGhostDetected: (() => void) | null;
  private readonly listeners: Array<(event: NarrationEvent) => void> = [];
  private readonly summary: JobSummary;

  private lastNarrationAt: number = 0;
  private cadenceMs: number;
  private cadenceTimer: ReturnType<typeof setTimeout> | null = null;
  private ghostTriggered = false;
  private lastActivityLabel: string | null = null;

  private readonly recordEvents: boolean;
  private readonly inMemoryEvents: Array<{ ts: string; kind: string; text: string | null }> =
    [];

  constructor(
    jobId: string,
    projectName: string,
    onGhostDetected?: () => void,
    recordEvents = true,
  ) {
    this.jobId = jobId;
    this.projectName = projectName;
    this.onGhostDetected = onGhostDetected ?? null;
    this.recordEvents = recordEvents;
    this.summary = {
      filesRead: [],
      filesWritten: [],
      shellCommands: [],
      lastThinking: null,
      elapsedMs: 0,
      startedAt: new Date(),
    };

    const { settings } = getConfig();
    this.cadenceMs = settings.narratorCadenceMs;
  }

  /** Subscribe to narration events. */
  onNarration(cb: (event: NarrationEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Recent progress lines (in-memory when recordEvents is false). */
  getRecentProgress(limit = 12): Array<{ ts: string; kind: string; text: string | null }> {
    return this.inMemoryEvents.slice(-limit);
  }

  private trackEvent(kind: string, payload?: unknown): void {
    let text: string | null = null;
    if (payload !== undefined) {
      try {
        text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      } catch {
        text = String(payload);
      }
    }
    this.inMemoryEvents.push({ ts: new Date().toISOString(), kind, text });
    if (this.inMemoryEvents.length > 40) this.inMemoryEvents.shift();
    if (this.recordEvents) {
      addJobEvent(this.jobId, kind as import('../state/jobs.js').JobEventKind, payload);
    }
  }

  /**
   * Process one normalized agent event.
   *
   * The spoken agent name comes from the active provider — narration used to
   * say "Cursor" no matter which CLI was running, which is exactly what the
   * hands-free user hears.
   */
  process(event: AgentStreamEvent): void {
    this.summary.elapsedMs = Date.now() - this.summary.startedAt.getTime();
    const agent = this.agentName();

    switch (event.kind) {
      case 'init':
        log.debug({ jobId: this.jobId }, 'job started');
        this.trackEvent('system_init', { model: event.model ?? null });
        this.emit({ kind: 'job_started', text: `${agent} started working on ${this.projectName}.` });
        // No cadence TTS ticks — the voice agent narrates via get_agent_status.
        return;

      case 'tool_start':
        this.handleToolCallStart(event.tool);
        return;

      case 'result': {
        this.stopCadenceTicks();
        const filesChanged = this.summary.filesWritten.length;
        const doneText =
          filesChanged > 0
            ? `Done — ${agent} changed ${filesChanged} file${filesChanged !== 1 ? 's' : ''}. Want to see the diff?`
            : `Done — ${agent} finished with no file changes.`;
        this.trackEvent('job_done', { summary: doneText });
        this.emit({ kind: 'job_done', text: doneText });
        return;
      }

      case 'error':
        this.stopCadenceTicks();
        this.trackEvent('job_error', { message: event.message });
        this.emit({ kind: 'job_error', text: `Something went wrong. ${agent} said: ${event.message}` });
        return;

      // session / tool_done / assistant_text carry no narration of their own.
      default:
        return;
    }
  }

  /** Display name of the coding agent currently running (Cursor / Codex / Claude Code). */
  private agentName(): string {
    return getActiveProvider().displayName;
  }

  /** Human-readable snapshot of what the agent is doing right now. */
  getActivitySummary(): string {
    if (this.lastActivityLabel) return this.lastActivityLabel;
    const s = this.getSummary();
    const parts: string[] = [];
    if (s.filesWritten.length > 0) {
      const last = s.filesWritten[s.filesWritten.length - 1];
      parts.push(`last wrote ${last}`);
    }
    if (s.shellCommands.length > 0) {
      const last = s.shellCommands[s.shellCommands.length - 1];
      parts.push(`last ran ${last}`);
    }
    if (s.filesRead.length > 0) {
      const last = s.filesRead[s.filesRead.length - 1];
      parts.push(
        s.filesRead.length === 1 ? `reading ${last}` : `read ${s.filesRead.length} files, last ${last}`,
      );
    }
    if (parts.length === 0) {
      return `${this.agentName()} is researching the codebase…`;
    }
    return parts.join('; ');
  }

  private handleToolCallStart(tool: NormalizedToolCall): void {
    const ghost = isGhostToolCall(tool);
    if (ghost.ghost && !this.ghostTriggered) {
      this.ghostTriggered = true;
      this.stopCadenceTicks();
      const reason = ghost.reason ?? 'subagent';
      log.warn({ jobId: this.jobId, reason }, 'ghost agent tool detected — killing job');
      this.trackEvent('ghost_killed', { reason });
      this.emit({
        kind: 'ghost_killed',
        text: `Stopped — ${this.agentName()} tried to spawn extra agents (${reason}). Budget protection kicked in.`,
      });
      this.onGhostDetected?.();
      return;
    }

    const label = describeToolCall(tool);
    this.lastActivityLabel = label;

    if (tool.action === 'write' && tool.path) {
      this.summary.filesWritten.push(tool.path);
      this.trackEvent('file_write', { path: tool.path });
      this.emit({ kind: 'file_write', text: `${this.agentName()} just wrote ${tool.path}.` });
    } else if (tool.action === 'read' || tool.action === 'search') {
      if (tool.path) this.summary.filesRead.push(tool.path);
      this.trackEvent('file_read', { path: tool.path ?? label });
    } else if (tool.action === 'shell') {
      if (tool.command) this.summary.shellCommands.push(tool.command);
      this.trackEvent('shell_run', { cmd: tool.command, label });
      // Raw commands are useful in logs/status but noisy and potentially
      // sensitive over TTS. Cadence ticks provide concise spoken progress.
    }
  }

  /** Return a snapshot of the current rolling summary. */
  getSummary(): Readonly<JobSummary> {
    this.summary.elapsedMs = Date.now() - this.summary.startedAt.getTime();
    return this.summary;
  }

  /** Stop timers (call when the job finishes or is killed). */
  destroy(): void {
    this.stopCadenceTicks();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Emit a NarrationEvent to all subscribers.
   * Transition events (file_write, job_done, job_error) bypass
   * the cadence gate. Only progress_tick is gated.
   */
  private emit(params: { kind: NarrationKind; text: string }): void {
    const isGated = params.kind === 'progress_tick';
    const now = Date.now();

    if (isGated && now - this.lastNarrationAt < this.cadenceMs) {
      return; // Too soon for a tick — drop it
    }

    this.lastNarrationAt = now;
    const event: NarrationEvent = {
      ...params,
      jobId: this.jobId,
      ts: new Date(),
    };

    for (const cb of this.listeners) {
      cb(event);
    }
  }

  /**
   * Formerly emitted count-only "Still working — read N files" TTS ticks.
   * Disabled: voice agent owns spoken progress. Kept as a no-op so call sites stay safe.
   */
  private startCadenceTicks(): void {
    this.stopCadenceTicks();
  }

  private stopCadenceTicks(): void {
    if (this.cadenceTimer) {
      clearTimeout(this.cadenceTimer);
      this.cadenceTimer = null;
    }
  }
}
