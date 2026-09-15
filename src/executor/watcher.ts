/**
 * Agent stream watcher & narration classifier.
 *
 * Receives *normalized* agent events (providers/agents/events.ts) rather than
 * raw CLI JSON, so narration works identically for Cursor, Codex and Claude
 * Code. Responsibilities:
 *   1. Turn normalized events into typed NarrationEvent kinds.
 *   2. Maintain a rolling JobSummary (accumulated across the run).
 *   3. Emit NarrationEvents. Every spoken string comes from the phrase catalog
 *      (voice/phrases.ts) so it can be switched off or reworded per event —
 *      see docs/39 Part B.
 *
 * See docs/12-stream-json-watcher.md for the full spec.
 */

import { addJobEvent, type JobEventKind } from '../state/jobs.js';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import type { AgentStreamEvent, NormalizedToolCall } from '../providers/agents/events.js';
import { phrase } from '../voice/phrases.js';

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
  | 'job_done'
  | 'job_error'
  | 'ghost_killed';

export interface NarrationEvent {
  kind: NarrationKind;
  text: string;
  jobId: string;
  ts: Date;
  /**
   * The event's own facts, independent of the spoken sentence. The PWA uses
   * these for the orb, the session log and push notifications, so they survive
   * a user who has turned this event's narration off.
   */
  data?: Record<string, unknown>;
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
      addJobEvent(this.jobId, kind as JobEventKind, payload);
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
        this.emit({
          kind: 'job_started',
          text: phrase('job_started', { agent, project: this.projectName }),
          data: { agent, project: this.projectName },
        });
        return;

      case 'tool_start':
        this.handleToolCallStart(event.tool);
        return;

      case 'result': {
        const filesChanged = this.summary.filesWritten.length;
        const doneText =
          filesChanged > 0
            ? phrase('job_done', { agent, count: filesChanged })
            : phrase('job_done_no_changes', { agent });
        this.trackEvent('job_done', { summary: doneText });
        this.emit({
          kind: 'job_done',
          text: doneText,
          data: { agent, count: filesChanged, files: this.summary.filesWritten.slice(-20) },
        });
        return;
      }

      case 'error':
        this.trackEvent('job_error', { message: event.message });
        this.emit({
          kind: 'job_error',
          text: phrase('job_error', { agent, message: event.message }),
          // The raw provider error stays in `data` for the transcript even when
          // the spoken line deliberately leaves it out.
          data: { agent, message: event.message },
        });
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
      const reason = ghost.reason ?? 'subagent';
      log.warn({ jobId: this.jobId, reason }, 'ghost agent tool detected — killing job');
      this.trackEvent('ghost_killed', { reason });
      this.emit({
        kind: 'ghost_killed',
        text: phrase('ghost_killed', { agent: this.agentName(), reason }),
        data: { agent: this.agentName(), reason },
      });
      this.onGhostDetected?.();
      return;
    }

    const label = describeToolCall(tool);
    this.lastActivityLabel = label;

    if (tool.action === 'write' && tool.path) {
      this.summary.filesWritten.push(tool.path);
      this.trackEvent('file_write', { path: tool.path });
      this.emit({
        kind: 'file_write',
        text: phrase('file_write', { agent: this.agentName(), path: tool.path }),
        data: { agent: this.agentName(), path: tool.path },
      });
    } else if (tool.action === 'read' || tool.action === 'search') {
      if (tool.path) this.summary.filesRead.push(tool.path);
      this.trackEvent('file_read', { path: tool.path ?? label });
      // Emitted, but `file_read` and `shell_run` default to mode `off` in the
      // phrase catalog: one spoken line per read would bury the agent's own
      // replies. Emitting them anyway is what makes the away digest's
      // "N commands run" a real number instead of a permanent 0 (docs/39 A1).
      this.emit({
        kind: 'file_read',
        text: phrase('file_read', { agent: this.agentName(), path: tool.path ?? label }),
        data: { agent: this.agentName(), path: tool.path ?? label },
      });
    } else if (tool.action === 'shell') {
      if (tool.command) this.summary.shellCommands.push(tool.command);
      this.trackEvent('shell_run', { cmd: tool.command, label });
      this.emit({
        kind: 'shell_run',
        text: phrase('shell_run', { agent: this.agentName(), command: tool.command ?? label }),
        data: { agent: this.agentName(), command: tool.command ?? label },
      });
    }
  }

  /** Return a snapshot of the current rolling summary. */
  getSummary(): Readonly<JobSummary> {
    this.summary.elapsedMs = Date.now() - this.summary.startedAt.getTime();
    return this.summary;
  }

  /** Release resources (call when the job finishes or is killed). */
  destroy(): void {
    this.listeners.length = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Emit a NarrationEvent to all subscribers.
   *
   * There is no cadence gate any more: the only event it ever applied to was
   * `progress_tick`, which nothing emitted, and its interval field made the
   * config screen advertise a control that did nothing (docs/39 A1). Whether a
   * line is actually spoken is now decided per event by
   * `shouldSpeakNarration`, downstream in the narrator.
   */
  private emit(params: { kind: NarrationKind; text: string; data?: Record<string, unknown> }): void {
    const event: NarrationEvent = {
      ...params,
      jobId: this.jobId,
      ts: new Date(),
    };

    for (const cb of this.listeners) {
      cb(event);
    }
  }
}
