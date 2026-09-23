/**
 * `agentvoice logs --files | --transcripts | --list | --cat` — the bridge's own
 * log files (docs/42-logging.md), for every install: journald only exists for a
 * systemd unit, but the session logs and transcripts are written however the
 * bridge was started.
 *
 *   <home>/logs/<runMode>/bridge/<date>.log        one per bridge run
 *   <home>/logs/<runMode>/transcripts/<date>.log   one per voice session
 *
 * Older files are .log.gz; --cat decompresses them, --follow tracks the newest
 * plain file across the midnight / size rollovers.
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { listLogFiles, type LogFileInfo } from '../../logging/logFiles.js';
import { logFolderPath, type LogFolder } from '../../logging/logPaths.js';
import { followFile, tailLines } from '../../logging/tail.js';
import { UsageError } from '../args.js';
import { envValue, readConfig, resolveHome } from '../home.js';
import { bold, dim, fail, note, say } from '../out.js';

export interface LogFileOptions {
  /** Voice transcripts instead of bridge session logs. */
  transcripts: boolean;
  /** List both folders instead of printing a file. */
  list: boolean;
  /** Print this file (`latest` = newest); .gz is decompressed. */
  cat?: string;
  follow: boolean;
  lines: number;
  /** Run profile folder; defaults to settings.runMode. */
  profile?: string;
}

export interface LogLocations {
  home: string;
  profile: 'serve' | 'test';
  bridge: string;
  transcripts: string;
  console: string;
}

/** Where this home's bridge writes its files, honouring settings.logging.dir and $AGENTVOICE_LOG_DIR. */
export function logLocations(profileOverride?: string): LogLocations {
  const home = resolveHome();
  const settings = readConfig(home).config?.settings as
    | { runMode?: string; logging?: { dir?: string } }
    | undefined;
  const profile = profileOverride ?? (settings?.runMode === 'serve' ? 'serve' : 'test');
  if (profile !== 'serve' && profile !== 'test') {
    throw new UsageError(`--profile must be serve or test (got "${profile}")`);
  }
  const envDir = envValue(home, 'AGENTVOICE_LOG_DIR');
  const opts = { home, ...(settings?.logging?.dir ? { dir: settings.logging.dir } : {}), ...(envDir ? { envDir } : {}) };
  const at = (folder: LogFolder): string => logFolderPath(opts, profile, folder);
  return { home, profile, bridge: at('bridge'), transcripts: at('transcripts'), console: at('console') };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printList(title: string, dir: string, files: LogFileInfo[]): void {
  say(`  ${bold(title)} ${dim(dir)}`);
  if (files.length === 0) {
    say(dim('    (none yet)'));
    say();
    return;
  }
  const newestPlain = files.find((f) => !f.compressed)?.name;
  for (const f of files) {
    const marker = f.name === newestPlain ? dim('  ← newest') : '';
    say(`    ${f.name.padEnd(34)} ${formatBytes(f.bytes).padStart(9)}${marker}`);
  }
  say();
}

async function catFile(path: string): Promise<void> {
  const input = createReadStream(path);
  const stream = path.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  for await (const chunk of stream) process.stdout.write(chunk as Buffer);
}

/** True when there is at least one bridge session log to show. */
export function hasSessionLogs(profileOverride?: string): boolean {
  try {
    return listLogFiles(logLocations(profileOverride).bridge).length > 0;
  } catch {
    return false;
  }
}

export async function logFilesCommand(opts: LogFileOptions): Promise<number> {
  const where = logLocations(opts.profile);
  const dir = opts.transcripts ? where.transcripts : where.bridge;

  if (opts.list) {
    printList('Bridge logs', where.bridge, listLogFiles(where.bridge));
    printList('Voice transcripts', where.transcripts, listLogFiles(where.transcripts));
    const consoleFiles = listLogFiles(where.console);
    if (consoleFiles.length) printList('Console captures', where.console, consoleFiles);
    return 0;
  }

  const files = listLogFiles(dir);
  if (opts.cat !== undefined) {
    const target =
      opts.cat === 'latest' ? files[0] : files.find((f) => f.name === opts.cat || f.path === opts.cat);
    if (!target) {
      fail(`no ${opts.cat === 'latest' ? 'files' : `"${opts.cat}"`} in ${dir} — see: agentvoice logs --list`);
      return 1;
    }
    await catFile(target.path);
    return 0;
  }

  const newest = (): string | null => listLogFiles(dir).find((f) => !f.compressed)?.path ?? null;
  const first = newest();
  if (!first) {
    fail(`no ${opts.transcripts ? 'transcripts' : 'session logs'} in ${dir} yet`);
    return 1;
  }
  note(dim(`${first}${opts.follow ? ' (following — Ctrl-C to stop)' : ''}`));
  for (const line of tailLines(first, opts.lines)) say(line);
  if (!opts.follow) return 0;

  let current = first;
  await new Promise<void>((stop) => {
    const follow = followFile(
      () => {
        const next = newest();
        if (next && next !== current) {
          current = next;
          note(dim(`--- now following ${next}`));
        }
        return next;
      },
      (line) => say(line),
    );
    process.once('SIGINT', () => {
      follow.stop();
      stop();
    });
  });
  return 0;
}
