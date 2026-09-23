/**
 * Log folder layout.
 *
 *   <logs>/<runMode>/bridge/        bridge session logs (logging/sessionLog.ts)
 *   <logs>/<runMode>/transcripts/   voice session transcripts (logging/transcripts.ts)
 *   <logs>/<runMode>/console/       raw stdout of a nohup'd bridge (scripts/start.sh)
 *
 * Splitting by run mode keeps `npm run dev` (test profile) and the host
 * service (serve profile) out of each other's folders — each profile binds its
 * own port, so exactly one live process ever writes to a folder, which is what
 * makes it safe for the archiver to compress everything else in it.
 */

import { join, resolve } from 'node:path';
import type { RunMode } from '../config.js';

export const LOG_FOLDERS = ['bridge', 'transcripts', 'console'] as const;
export type LogFolder = (typeof LOG_FOLDERS)[number];

export interface LogDirOptions {
  /** settings.logging.dir */
  dir?: string;
  /** $AGENTVOICE_LOG_DIR, when the caller reads it from somewhere other than process.env. */
  envDir?: string;
  /**
   * The bridge home that relative paths resolve against. The bridge runs with
   * its home as the working directory (src/cli/commands/run.ts chdirs there),
   * so the default is right for it; the CLI passes the home it resolved.
   */
  home?: string;
}

/** Base log directory: `AGENTVOICE_LOG_DIR`, else `settings.logging.dir`, else ./logs. */
export function logBaseDir(opts: LogDirOptions = {}): string {
  const base = (opts.envDir ?? process.env['AGENTVOICE_LOG_DIR'])?.trim() || opts.dir || 'logs';
  return resolve(opts.home ?? process.cwd(), base);
}

/** `<logs>/<runMode>` — everything this profile writes. */
export function logProfileDir(opts: LogDirOptions, runMode: RunMode): string {
  return join(logBaseDir(opts), runMode);
}

export function logFolderPath(opts: LogDirOptions, runMode: RunMode, folder: LogFolder): string {
  return join(logProfileDir(opts, runMode), folder);
}
