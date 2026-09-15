/**
 * Session directory — every agent session the user could be talking about, in
 * one list (docs/37 §1, #56).
 *
 * Before this the phone could only see rows AgentVoice itself had written:
 * `listCursorSessionsForProject` reads the `job` and `voice_agent_run` tables
 * and nothing else. Meanwhile the host routinely runs several `claude`
 * sessions the user started themselves, and the bridge's own worktree workers
 * were invisible to `inject`.
 *
 * Four kinds, per the design:
 *
 *   A. the voice agent           — `getActiveVoiceAgent()`
 *   B. bridge workers            — the singleton and the worktree pool
 *   C. past resumable sessions   — the CLI's own store, via `provider.listSessions`
 *   D. external live sessions    — a same-uid process scan, cwd matched to a
 *                                  registered project
 *
 * Kinds C and D read undocumented, vendor-internal state, so everything here is
 * best-effort by construction: an unreadable store contributes nothing rather
 * than throwing, exactly as `sessionStatus()` treats `unknown`.
 *
 * Security (docs/37 §4): only sessions whose cwd is inside a *registered*
 * project are visible at all — not merely read-only, hidden — and the scan
 * never looks outside the current uid's own processes.
 */

import { readdirSync, readlinkSync, readFileSync, statSync } from 'node:fs';
import { childLogger } from '../log.js';
import { getActiveVoiceAgent } from '../executor/voiceAgent.js';
import { getAllActiveRuns } from '../executor/agentSingleton.js';
import { getActiveProvider, getProvider } from '../providers/agents/registry.js';
import { listProjectsWithPaths, type Project } from './registry.js';
import { pendingCount } from './sessionMailbox.js';
import { AGENT_CLIENTS, getConfig, type AgentClient } from '../config.js';

const log = childLogger('session-directory');

export type SessionKind = 'voice' | 'worker' | 'recent' | 'external';

/**
 * How a message can actually reach this session. Reported on every row so the
 * user is told the truth rather than "sent" for something that vanished.
 */
export type DeliveryMethod =
  | 'live'
  | 'mailbox'
  | 'queued_next_turn'
  | 'fork'
  | 'resume'
  | 'read_only';

export interface SessionEntry {
  /** Stable handle the tools take: the job id, run id, or `<provider>:<session id>`. */
  handle: string;
  kind: SessionKind;
  /** Two-word spoken name ("auth worker") — what the user says out loud. */
  name: string;
  project: string;
  provider: AgentClient;
  providerName: string;
  /** The CLI's own conversation id, when known. */
  sessionId: string | null;
  pid: number | null;
  status: 'thinking' | 'tool' | 'waiting' | 'idle' | 'done' | 'error' | 'unknown';
  startedAt: string | null;
  lastActivityAt: string | null;
  elapsedMs: number | null;
  /** How a message would be delivered, and whether it needs confirmation. */
  delivery: DeliveryMethod;
  requiresConfirmation: boolean;
  /** Messages waiting in this session's mailbox. */
  pendingMessages: number;
  /** One line of what it is doing / was asked to do. */
  summary: string | null;
}

export interface DirectoryOptions {
  /** Restrict to one project by name. */
  project?: string | null;
  /** Which kinds to include. Defaults to everything. */
  scope?: SessionKind[] | null;
  /** Per-kind cap on how many rows to read from a CLI store. */
  limit?: number;
}

// ── Spoken names ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'for', 'of', 'with', 'please',
  'can', 'you', 'make', 'add', 'fix', 'update', 'change', 'run', 'do', 'is', 'it',
  'this', 'that', 'my', 'our', 'we', 'i', 'me',
]);

/**
 * A two-word name the user can say out loud.
 *
 * Handles are UUIDs; "stop 9f3c-…" is not a thing anybody says. The worktree
 * name is the best source when there is one, because the user usually chose
 * it; otherwise the first content words of the prompt.
 */
export function spokenName(params: {
  worktree?: string | null;
  prompt?: string | null;
  kind: SessionKind;
  index: number;
}): string {
  const fromWorktree = params.worktree?.replace(/[-_]+/g, ' ').trim();
  if (fromWorktree) return `${firstWords(fromWorktree, 1)} worker`;

  const words = (params.prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length > 0) return `${words.slice(0, 1).join(' ')} ${kindNoun(params.kind)}`;

  return `${kindNoun(params.kind)} ${params.index + 1}`;
}

function kindNoun(kind: SessionKind): string {
  switch (kind) {
    case 'voice':
      return 'voice';
    case 'worker':
      return 'worker';
    case 'recent':
      return 'thread';
    case 'external':
      return 'session';
  }
}

function firstWords(text: string, count: number): string {
  return text.split(/\s+/).slice(0, count).join(' ');
}

// ── Kind A + B: what the bridge itself is running ───────────────────────────

function voiceEntries(opts: DirectoryOptions): SessionEntry[] {
  const voice = getActiveVoiceAgent();
  if (!voice) return [];
  if (opts.project && voice.project !== opts.project) return [];
  const provider = getActiveProvider();
  return [
    {
      handle: voice.runId,
      kind: 'voice',
      name: 'the voice agent',
      project: voice.project,
      provider: provider.id,
      providerName: provider.displayName,
      sessionId: voice.sessionId ?? null,
      pid: voice.pid,
      status: 'thinking',
      startedAt: null,
      lastActivityAt: null,
      elapsedMs: null,
      // The voice turn queue is a genuine live channel into this process.
      delivery: 'live',
      requiresConfirmation: false,
      pendingMessages: pendingCount(voice.runId),
      summary: 'The agent you are talking to.',
    },
  ];
}

function workerEntries(opts: DirectoryOptions): SessionEntry[] {
  const provider = getActiveProvider();
  const out: SessionEntry[] = [];
  let index = 0;
  for (const run of getAllActiveRuns()) {
    const summary = run.watcher?.getActivitySummary() ?? null;
    const entry: SessionEntry = {
      handle: run.refId,
      kind: 'worker',
      name: spokenName({ worktree: run.worktreeName ?? null, kind: 'worker', index: index++ }),
      project: opts.project ?? '',
      provider: provider.id,
      providerName: provider.displayName,
      sessionId: null,
      pid: run.pid,
      status: summary ? 'tool' : 'thinking',
      startedAt: run.startedAt.toISOString(),
      lastActivityAt: null,
      elapsedMs: Date.now() - run.startedAt.getTime(),
      // A running worker reads its mailbox on its next AgentVoice tool call.
      delivery: 'mailbox',
      requiresConfirmation: false,
      pendingMessages: pendingCount(run.refId),
      summary,
    };
    out.push(entry);
  }
  return out;
}

// ── Kind C: past conversations from the CLI's own store ─────────────────────

function recentEntries(project: Project, opts: DirectoryOptions): SessionEntry[] {
  const out: SessionEntry[] = [];
  const limit = opts.limit ?? 10;
  for (const clientId of AGENT_CLIENTS) {
    const provider = getProvider(clientId);
    if (!provider.listSessions) continue;
    let sessions;
    try {
      sessions = provider.listSessions(project, limit);
    } catch (err) {
      // Vendor store layouts change without notice; a broken reader must never
      // take the whole directory down with it.
      log.debug({ err, provider: clientId }, 'listSessions failed — skipping this CLI');
      continue;
    }
    let index = 0;
    for (const session of sessions) {
      const canFork = Boolean(provider.forkSessionArgs?.(project, session.id, ''));
      out.push({
        handle: `${clientId}:${session.id}`,
        kind: 'recent',
        name: spokenName({ prompt: session.preview ?? null, kind: 'recent', index: index++ }),
        project: project.name,
        provider: clientId,
        providerName: provider.displayName,
        sessionId: session.id,
        pid: null,
        status: 'idle',
        startedAt: null,
        lastActivityAt: new Date(session.updatedAt).toISOString(),
        elapsedMs: null,
        // Nothing is running, so the message starts a new turn in the thread.
        delivery: canFork ? 'fork' : 'resume',
        requiresConfirmation: true,
        pendingMessages: 0,
        summary: session.preview ?? null,
      });
    }
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out.slice(0, limit);
}

// ── Kind D: live sessions the user started themselves ───────────────────────

/** Binary basenames that count as an agent CLI, keyed by provider. */
const CLI_BASENAMES: Record<AgentClient, string[]> = {
  cursor: ['cursor-agent'],
  codex: ['codex'],
  'claude-code': ['claude'],
  codewhale: ['codewhale'],
};

export interface ExternalProcess {
  pid: number;
  provider: AgentClient;
  cwd: string;
  cmdline: string;
}

/**
 * Same-uid scan of `/proc` for agent CLIs the user started.
 *
 * Deliberately uid-scoped and read-only: it never reads another user's home,
 * and multi-user hosts would need per-user tokens first (docs/03). On a
 * platform without `/proc` this returns nothing rather than pretending.
 */
export function scanExternalAgentProcesses(): ExternalProcess[] {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const out: ExternalProcess[] = [];

  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      // Same user only. `/proc/<pid>` is owned by the process's uid.
      if (uid !== null && statSync(`/proc/${pid}`).uid !== uid) continue;

      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
      if (cmdline.length === 0) continue;
      const argv0 = (cmdline[0] ?? '').split('/').pop() ?? '';
      const provider = providerForBinary(argv0, cmdline);
      if (!provider) continue;

      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      out.push({ pid: Number(pid), provider, cwd, cmdline: cmdline.join(' ') });
    } catch {
      // A process that exits mid-scan, or one whose /proc entries we cannot
      // read, is simply not listed.
    }
  }
  return out;
}

function providerForBinary(argv0: string, cmdline: string[]): AgentClient | null {
  for (const client of AGENT_CLIENTS) {
    if (CLI_BASENAMES[client].includes(argv0)) return client;
  }
  // `node /path/to/claude …` and friends — check the script argument too.
  const second = (cmdline[1] ?? '').split('/').pop() ?? '';
  for (const client of AGENT_CLIENTS) {
    if (CLI_BASENAMES[client].includes(second)) return client;
  }
  return null;
}

/** Is any live process likely to own this session id right now? */
export function isSessionLive(sessionId: string): boolean {
  return scanExternalAgentProcesses().some((proc) => proc.cmdline.includes(sessionId));
}

function externalEntries(projects: Project[], opts: DirectoryOptions): SessionEntry[] {
  const bridgePids = new Set<number>();
  for (const run of getAllActiveRuns()) bridgePids.add(run.pid);
  const voice = getActiveVoiceAgent();
  if (voice) bridgePids.add(voice.pid);

  const out: SessionEntry[] = [];
  let index = 0;
  for (const proc of scanExternalAgentProcesses()) {
    if (bridgePids.has(proc.pid)) continue;
    const project = projects.find((p) => proc.cwd === p.path || proc.cwd.startsWith(`${p.path}/`));
    // Not inside a registered project → hidden entirely, not read-only.
    if (!project) continue;
    if (opts.project && project.name !== opts.project) continue;

    const provider = getProvider(proc.provider);
    /**
     * Writing into a session AgentVoice did not start *is* prompt injection,
     * and that session may be running with bypass permissions — so anyone
     * holding APP_TOKEN could otherwise drive it. Off unless the project opts
     * in (docs/37 §4); until then the row is visible but read-only.
     */
    const writable = externalWritesAllowed(project.name) && Boolean(provider.forkSessionArgs);
    const session = newestSessionFor(provider, project);
    out.push({
      handle: `pid:${proc.pid}`,
      kind: 'external',
      name: spokenName({ kind: 'external', index: index++ }),
      project: project.name,
      provider: proc.provider,
      providerName: provider.displayName,
      sessionId: session?.id ?? null,
      pid: proc.pid,
      status: 'unknown',
      startedAt: null,
      lastActivityAt: session ? new Date(session.updatedAt).toISOString() : null,
      elapsedMs: null,
      /**
       * An external session is not ours to resume: doing so while its own
       * process still holds the transcript corrupts it. Forking is the safe
       * way in; without a fork flag the session is read-only from here.
       */
      delivery: writable ? 'fork' : 'read_only',
      requiresConfirmation: true,
      pendingMessages: 0,
      summary: `Started outside AgentVoice in ${proc.cwd}`,
    });
  }
  return out;
}

function newestSessionFor(
  provider: ReturnType<typeof getProvider>,
  project: Project,
): { id: string; updatedAt: number } | null {
  try {
    const sessions = provider.listSessions?.(project, 1) ?? [];
    return sessions[0] ?? null;
  } catch {
    return null;
  }
}

// ── The directory ───────────────────────────────────────────────────────────

export function listSessions(opts: DirectoryOptions = {}): SessionEntry[] {
  const scope = new Set<SessionKind>(opts.scope ?? ['voice', 'worker', 'recent', 'external']);
  // Paths are needed to match a process's cwd; they never leave the server.
  const projects = listProjectsWithPaths().filter((p) => p.enabled);
  const scoped = opts.project ? projects.filter((p) => p.name === opts.project) : projects;

  const out: SessionEntry[] = [];
  if (scope.has('voice')) out.push(...voiceEntries(opts));
  if (scope.has('worker')) out.push(...workerEntries(opts));
  if (scope.has('recent')) {
    for (const project of scoped) out.push(...recentEntries(project, opts));
  }
  if (scope.has('external')) out.push(...externalEntries(scoped, opts));

  // A handle can legitimately appear twice (a worker whose thread is also in
  // the CLI store); the live row is the useful one.
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = entry.sessionId ? `${entry.provider}:${entry.sessionId}` : entry.handle;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Has this project opted into messages reaching sessions it did not start? */
export function externalWritesAllowed(projectName: string): boolean {
  const entry = getConfig().projects.find((p) => p.name === projectName);
  return entry?.allowExternalSessions === true;
}

/** Resolve a spoken name, an ordinal, or a handle to exactly one session. */
export function resolveSession(
  query: string,
  opts: DirectoryOptions = {},
): { entry: SessionEntry | null; matches: SessionEntry[] } {
  const sessions = listSessions(opts);
  const q = query.trim().toLowerCase();

  const exact = sessions.find((s) => s.handle.toLowerCase() === q);
  if (exact) return { entry: exact, matches: [exact] };

  // "the second one" / "number two"
  const ordinal = ORDINALS[q.replace(/^(the|number)\s+/, '').replace(/\s+one$/, '')];
  if (ordinal !== undefined && sessions[ordinal]) {
    return { entry: sessions[ordinal], matches: [sessions[ordinal]] };
  }

  const byName = sessions.filter((s) => s.name.toLowerCase().includes(q));
  if (byName.length === 1) return { entry: byName[0]!, matches: byName };
  if (byName.length > 1) return { entry: null, matches: byName };

  const bySession = sessions.filter((s) => s.sessionId?.startsWith(query));
  if (bySession.length === 1) return { entry: bySession[0]!, matches: bySession };

  return { entry: null, matches: bySession };
}

const ORDINALS: Record<string, number> = {
  first: 0, '1st': 0, one: 0,
  second: 1, '2nd': 1, two: 1,
  third: 2, '3rd': 2, three: 2,
  fourth: 3, '4th': 3, four: 3,
  last: -1,
};
