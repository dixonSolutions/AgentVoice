/**
 * Voice session transcripts — what was said, by whom, and when.
 *
 *   logs/<runMode>/transcripts/2026-09-23_14-06-01.log
 *
 *   # AgentVoice voice transcript
 *   # opened 2026-09-23 14:06:01.204 (UTC+10:00) — session start
 *   # agent=Claude Code · workflow=agent_native · input=turns · project=site
 *   [14:06:04] USER (phone): fix the login redirect
 *   [14:06:06] AGENT: Looking at the auth middleware now.
 *   [14:06:40] NARRATOR: The worker finished — two files changed.
 *   [14:06:41] EVENT: voice agent done
 *   # session ended 2026-09-23 14:20:13.880 (all voice clients disconnected)
 *
 * A "session" is a stretch of time with at least one voice client connected —
 * the phone's /ws/intelligence socket or an audio pipe on /ws/audio-stream.
 * A short grace period after the last client leaves absorbs the phone's
 * reconnects, so a flaky network does not shred one conversation into ten
 * files. Old transcripts are gzipped exactly like bridge logs (logFiles.ts).
 */

import { formatTimestamp } from './format.js';
import { RotatingFile, queueArchive, type ArchiveResult, type RotateReason } from './logFiles.js';

export interface TranscriptSettings {
  enabled: boolean;
  dir: string;
  keepPlain: number;
  maxFileMb: number;
  retentionDays: number;
  /** Facts written into each transcript header (agent, workflow, project…). */
  describe?: () => Record<string, string | number | boolean | null | undefined>;
  /** How long to keep a transcript open after the last client leaves. */
  graceMs?: number;
}

/** Where a user turn came from — the turn source (phone, desk, rest, stream…). */
export type TranscriptUserSource = string;

const DEFAULT_GRACE_MS = 120_000;

const REASON_TEXT: Record<RotateReason, string> = {
  start: 'session start',
  midnight: 'midnight rollover',
  size: 'size rollover',
};

let settings: TranscriptSettings | null = null;
let file: RotatingFile | null = null;
let clients = 0;
let closeTimer: NodeJS.Timeout | null = null;
/** Last EVENT line, so a status broadcast repeated verbatim is written once. */
let lastEvent = '';

function clock(d = new Date()): string {
  return formatTimestamp(d.getTime()).slice(11, 19);
}

function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function header(reason: RotateReason, previous: string | null): string {
  const at = new Date();
  const lines = [
    '# AgentVoice voice transcript',
    `# opened ${formatTimestamp(at.getTime())} (UTC${utcOffset(at)}) — ${REASON_TEXT[reason]}`,
  ];
  if (previous) lines.push(`# continued from ${previous.split('/').pop()}`);
  const facts = settings?.describe?.() ?? {};
  const rendered = Object.entries(facts)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  if (rendered.length) lines.push(`# ${rendered.join(' · ')}`);
  return `${lines.join('\n')}\n`;
}

/** Install (or replace) transcript settings. `null` or `enabled: false` turns recording off. */
export function configureTranscripts(next: TranscriptSettings | null): void {
  if (file && (!next || !next.enabled || next.dir !== settings?.dir)) {
    endTranscript('transcripts reconfigured');
  }
  settings = next && next.enabled ? next : null;
}

export function transcriptsEnabled(): boolean {
  return settings !== null;
}

/** Path of the transcript being written right now, if any. */
export function currentTranscriptPath(): string | null {
  return file?.path ?? null;
}

function openTranscript(): RotatingFile | null {
  if (!settings) return null;
  if (file) return file;
  try {
    const dir = settings.dir;
    file = new RotatingFile({
      dir,
      maxBytes: Math.max(0, settings.maxFileMb) * 1024 * 1024,
      daily: true,
      header: ({ reason, previous }) => header(reason, previous),
      onRotate: () => {
        void archiveTranscripts();
      },
      onError: (err) => {
        process.stderr.write(`[transcript] recording disabled for this session — ${err.message}\n`);
      },
    });
  } catch (err) {
    process.stderr.write(
      `[transcript] could not open a transcript file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    file = null;
  }
  return file;
}

function endTranscript(reason: string, archive = true): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (!file) return;
  file.close(`# session ended ${formatTimestamp(Date.now())} (${reason})\n`);
  file = null;
  lastEvent = '';
  if (archive) void archiveTranscripts();
}

function write(label: string, text: string): void {
  const f = file;
  if (!f) return;
  const body = text.trim().replace(/\r?\n/g, '\n    ');
  if (!body) return;
  f.write(`[${clock()}] ${label}: ${body}\n`);
}

/** A voice client (phone, audio pipe) connected. Opens a transcript if none is open. */
export function transcriptClientConnected(client: string): void {
  clients += 1;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
    write('EVENT', `${client} reconnected`);
    return;
  }
  const wasOpen = file !== null;
  if (!openTranscript()) return;
  write('EVENT', wasOpen ? `${client} joined` : `${client} connected`);
}

/** A voice client left. The transcript closes once none remain (after a grace period). */
export function transcriptClientDisconnected(client: string): void {
  clients = Math.max(0, clients - 1);
  write('EVENT', `${client} disconnected`);
  if (clients > 0 || !file) return;
  const graceMs = settings?.graceMs ?? DEFAULT_GRACE_MS;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (clients === 0) endTranscript('all voice clients disconnected');
  }, graceMs);
  closeTimer.unref();
}

export function recordUserTurn(text: string, source: TranscriptUserSource = 'phone'): void {
  write(`USER (${source})`, text);
}

/** `note` marks a line nobody heard live, e.g. "unheard" while the phone is away. */
export function recordAgentSpeech(text: string, note?: string): void {
  write(note ? `AGENT (${note})` : 'AGENT', text);
}

export function recordNarration(text: string): void {
  write('NARRATOR', text);
}

export function recordTranscriptEvent(text: string): void {
  if (text === lastEvent) return;
  lastEvent = text;
  write('EVENT', text);
}

/** Compress older transcripts (never the open one). */
export function archiveTranscripts(): Promise<ArchiveResult | null> {
  if (!settings) return Promise.resolve(null);
  return queueArchive(
    settings.dir,
    { keepPlain: settings.keepPlain, retentionDays: settings.retentionDays },
    () => (file ? [file.path] : []),
  );
}

/**
 * Close the open transcript immediately (bridge shutdown). No archiving here:
 * the process is about to exit and would cut a gzip off half-written — the
 * next startup compresses it instead.
 */
export function closeTranscripts(reason = 'bridge shutdown'): void {
  endTranscript(reason, false);
  clients = 0;
}
