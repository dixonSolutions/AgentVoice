/**
 * The bridge's own session log: one text file per process run.
 *
 *   logs/<runMode>/bridge/2026-09-23_14-05-12.log      ← this run
 *   logs/<runMode>/bridge/2026-09-22_08-30-01.log      ← kept plain (keepPlain)
 *   logs/<runMode>/bridge/2026-09-21_19-02-44.log.gz   ← older, compressed
 *
 * Each file opens with a header naming the session (version, pid, run mode…)
 * and closes with a footer, so a file that ends without one is a crash.
 */

import { formatLogLine, formatTimestamp } from './format.js';
import { RotatingFile, queueArchive, type ArchiveResult, type RotateReason } from './logFiles.js';

const LEVEL_VALUES: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface SessionLogOptions {
  /** Folder for this profile's bridge logs, e.g. `<logs>/serve/bridge`. */
  dir: string;
  keepPlain: number;
  /** Roll to a new file past this size. 0 = only at midnight. */
  maxFileMb: number;
  retentionDays: number;
  /** Facts about this run, written into every file header. */
  describe?: () => Record<string, string | number | boolean | null | undefined>;
}

const REASON_TEXT: Record<RotateReason, string> = {
  start: 'session start',
  midnight: 'midnight rollover',
  size: 'size rollover',
};

function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export class SessionLog {
  readonly startedAt = new Date();
  private readonly file: RotatingFile;

  constructor(private readonly opts: SessionLogOptions) {
    this.file = new RotatingFile({
      dir: opts.dir,
      maxBytes: Math.max(0, opts.maxFileMb) * 1024 * 1024,
      daily: true,
      header: ({ reason, previous }) => this.header(reason, previous),
      onRotate: () => {
        void this.archive();
      },
      onError: (err) => {
        process.stderr.write(`[log] session log disabled — ${err.message}\n`);
      },
    });
  }

  /** File currently being written. */
  get path(): string {
    return this.file.path;
  }

  get dir(): string {
    return this.opts.dir;
  }

  /**
   * Append one serialized pino line as text. `minLevel` filters replayed boot
   * lines; live lines are already filtered by pino's multistream.
   */
  writeLine(line: string, minLevel?: string): void {
    if (minLevel) {
      const level = Number(/"level":(\d+)/.exec(line)?.[1] ?? 30);
      if (level < (LEVEL_VALUES[minLevel] ?? 0)) return;
    }
    this.file.write(`${formatLogLine(line)}\n`);
  }

  /** Compress older files in this folder (never the open one). */
  archive(): Promise<ArchiveResult> {
    return queueArchive(
      this.opts.dir,
      { keepPlain: this.opts.keepPlain, retentionDays: this.opts.retentionDays },
      () => [this.file.path],
    );
  }

  close(reason = 'shutdown'): void {
    const at = new Date();
    this.file.close(`# session ended ${formatTimestamp(at.getTime())} (${reason})\n`);
  }

  private header(reason: RotateReason, previous: string | null): string {
    const at = new Date();
    const lines = [
      '# AgentVoice bridge log',
      `# opened ${formatTimestamp(at.getTime())} (UTC${utcOffset(at)}) — ${REASON_TEXT[reason]}`,
      `# session started ${formatTimestamp(this.startedAt.getTime())}`,
    ];
    if (previous) lines.push(`# continued from ${previous.split('/').pop()}`);
    const facts = this.opts.describe?.() ?? {};
    const rendered = Object.entries(facts)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`);
    if (rendered.length) lines.push(`# ${rendered.join(' · ')}`);
    return `${lines.join('\n')}\n`;
  }
}
