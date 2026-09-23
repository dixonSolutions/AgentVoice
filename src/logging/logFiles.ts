/**
 * Date-named log files that roll over and compress themselves.
 *
 * Every folder managed here (bridge logs, voice transcripts, console captures)
 * follows the same rules:
 *
 *   - one file per session, named by its start time: 2026-09-23_14-05-12.log
 *   - a long session rolls to a fresh file at local midnight, or past a size cap
 *   - the newest `keepPlain` files stay as plain text; older ones are gzipped
 *     (2026-09-22_09-12-40.log.gz), so they pile up at ~10% of their size
 *   - optionally, archives older than `retentionDays` are deleted
 *
 * Names start with the date so `ls` order is chronological order, which is also
 * the order the archiver relies on.
 *
 * Writes are synchronous on purpose: the last lines before a crash are the ones
 * you most need, and an async buffer is exactly what loses them on
 * `process.exit(1)`.
 */

import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

// ── Names ────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time stamp used in file names: 2026-09-23_14-05-12. */
export function fileStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/** Local calendar day, for midnight rollover. */
export function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A path for a new file stamped `d` that collides with nothing already there —
 * two sessions starting in the same second get `_2`, `_3`, …
 */
export function uniqueLogPath(dir: string, d: Date = new Date()): string {
  const stamp = fileStamp(d);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stamp}.log` : `${stamp}_${n}.log`;
    const path = join(dir, name);
    if (!existsSync(path) && !existsSync(`${path}.gz`)) return path;
  }
}

// ── Rotating writer ──────────────────────────────────────────────────────

export type RotateReason = 'start' | 'midnight' | 'size';

export interface RotatingFileOptions {
  dir: string;
  /** Roll to a new file once this many bytes are written. 0 disables. */
  maxBytes?: number;
  /** Roll at local midnight so a file never spans two dates. Default true. */
  daily?: boolean;
  /** Text written at the top of each file (should end with a newline). */
  header?: (ctx: { path: string; reason: RotateReason; previous: string | null }) => string;
  /** Called with the path of a file that was just closed by a rollover. */
  onRotate?: (closedPath: string) => void;
  /** Called once if the file becomes unwritable (disk full, dir removed…). */
  onError?: (err: Error) => void;
  /** Clock override for tests. */
  now?: () => Date;
}

export class RotatingFile {
  private fd: number | null = null;
  private bytes = 0;
  private day = '';
  private failed = false;
  private currentPath = '';
  private readonly now: () => Date;

  constructor(private readonly opts: RotatingFileOptions) {
    this.now = opts.now ?? (() => new Date());
    mkdirSync(opts.dir, { recursive: true });
    this.open('start', null);
  }

  /** Path of the file currently being written. */
  get path(): string {
    return this.currentPath;
  }

  get isOpen(): boolean {
    return this.fd !== null && !this.failed;
  }

  /** Append text (caller supplies the trailing newline). Never throws. */
  write(text: string): void {
    if (this.fd === null || this.failed) return;
    try {
      const size = Buffer.byteLength(text);
      this.maybeRotate(size);
      writeSync(this.fd, text);
      this.bytes += size;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Force a new file now (e.g. an explicit "new session" boundary). */
  rotate(reason: RotateReason): void {
    if (this.fd === null || this.failed) return;
    const previous = this.currentPath;
    this.closeFd();
    this.open(reason, previous);
    this.opts.onRotate?.(previous);
  }

  /** Write an optional footer and close. Safe to call twice. */
  close(footer?: string): void {
    if (this.fd === null) return;
    if (footer && !this.failed) {
      try {
        writeSync(this.fd, footer);
      } catch {
        // closing anyway
      }
    }
    this.closeFd();
  }

  private maybeRotate(incoming: number): void {
    const now = this.now();
    if (this.opts.daily !== false && dayKey(now) !== this.day) {
      this.rotate('midnight');
      return;
    }
    const max = this.opts.maxBytes ?? 0;
    if (max > 0 && this.bytes > 0 && this.bytes + incoming > max) {
      this.rotate('size');
    }
  }

  private open(reason: RotateReason, previous: string | null): void {
    const at = this.now();
    this.currentPath = uniqueLogPath(this.opts.dir, at);
    this.fd = openSync(this.currentPath, 'a', 0o640);
    this.bytes = 0;
    this.day = dayKey(at);
    const header = this.opts.header?.({ path: this.currentPath, reason, previous });
    if (header) {
      writeSync(this.fd, header);
      this.bytes += Buffer.byteLength(header);
    }
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
  }

  private fail(err: unknown): void {
    this.failed = true;
    this.closeFd();
    this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Listing ──────────────────────────────────────────────────────────────

export interface LogFileInfo {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
  compressed: boolean;
}

const LOG_NAME = /\.log(\.gz)?$/;

/** Log files in `dir`, newest first. Missing dir → empty list. */
export function listLogFiles(dir: string): LogFileInfo[] {
  if (!existsSync(dir)) return [];
  const out: LogFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!LOG_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({
        name,
        path,
        bytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        compressed: name.endsWith('.gz'),
      });
    } catch {
      // raced with the archiver
    }
  }
  // Date-first names sort chronologically; `.gz` is stripped so an archive and
  // a plain file of the same session compare by stamp alone.
  return out.sort((a, b) => b.name.replace(/\.gz$/, '').localeCompare(a.name.replace(/\.gz$/, '')));
}

// ── Compression + retention ──────────────────────────────────────────────

/** gzip `path` to `path.gz` (keeping its mtime) and remove the original. */
export async function gzipFile(path: string): Promise<string> {
  const target = `${path}.gz`;
  const partial = `${target}.partial`;
  const st = statSync(path);
  await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(partial));
  renameSync(partial, target);
  // Retention is by age, so the archive must keep the session's own age.
  utimesSync(target, st.atime, st.mtime);
  unlinkSync(path);
  return target;
}

export interface ArchivePolicy {
  /** Newest plain .log files left uncompressed (including any still open). */
  keepPlain: number;
  /** Delete archives older than this many days. 0 = keep forever. */
  retentionDays: number;
}

export interface ArchiveResult {
  compressed: string[];
  deleted: string[];
  errors: string[];
}

const DAY_MS = 86_400_000;

/**
 * Compress everything past the newest `keepPlain` plain files, then apply
 * retention. `exclude` names files that are open right now — they are never
 * touched regardless of age.
 */
export async function archiveLogDir(
  dir: string,
  policy: ArchivePolicy,
  opts: { exclude?: Iterable<string>; now?: Date } = {},
): Promise<ArchiveResult> {
  const result: ArchiveResult = { compressed: [], deleted: [], errors: [] };
  const exclude = new Set([...(opts.exclude ?? [])].map((p) => basename(p)));
  const files = listLogFiles(dir);

  const plain = files.filter((f) => !f.compressed);
  const keep = Math.max(1, policy.keepPlain);
  for (const file of plain.slice(keep)) {
    if (exclude.has(file.name)) continue;
    try {
      result.compressed.push(await gzipFile(file.path));
    } catch (err) {
      result.errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (policy.retentionDays > 0) {
    const cutoff = (opts.now ?? new Date()).getTime() - policy.retentionDays * DAY_MS;
    for (const file of listLogFiles(dir)) {
      if (!file.compressed || exclude.has(file.name)) continue;
      if (new Date(file.modifiedAt).getTime() >= cutoff) continue;
      try {
        unlinkSync(file.path);
        result.deleted.push(file.path);
      } catch (err) {
        result.errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

/**
 * Serialize archiving per folder: a rollover that lands while the startup pass
 * is still compressing must not try to gzip the same file twice.
 */
const archiveChains = new Map<string, Promise<unknown>>();

export function queueArchive(
  dir: string,
  policy: ArchivePolicy,
  exclude: () => Iterable<string>,
): Promise<ArchiveResult> {
  const prev = archiveChains.get(dir) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => archiveLogDir(dir, policy, { exclude: exclude() }));
  archiveChains.set(dir, next);
  return next;
}
