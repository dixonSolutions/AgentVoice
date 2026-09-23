/**
 * Structured logging via pino. A single root logger fans out to:
 *
 *   - the terminal — colored text on a TTY, raw JSON otherwise (journald)
 *   - a text .log file per bridge session, named by start time, rolled at
 *     midnight / a size cap and gzipped once older (see logging/sessionLog.ts)
 *
 * Audit events get an `audit: true` marker so they can be separated in log
 * queries.
 *
 * Module loggers are declared at import time (`const log = childLogger('x')`),
 * long before config is loaded. They used to bind to a default logger that
 * initLogger() then replaced, so `settings.logLevel` never reached them. They
 * are now thin proxies that always resolve against the live root, so the
 * level and destinations chosen at startup apply everywhere.
 */

import pino from 'pino';
import { createHash } from 'node:crypto';
import { formatLogLine } from './logging/format.js';
import { SessionLog, type SessionLogOptions } from './logging/sessionLog.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  // The CLI (src/cli/silence.ts) and `npm test` (LOG_LEVEL=silent) turn the
  // bridge's logging off entirely.
  silent: Infinity,
};

interface LineStream {
  write(line: string): void;
}

/** Terminal output: readable text on a TTY, JSON lines for journald / pipes. */
const consoleStream: LineStream = {
  write(line: string): void {
    if (process.stdout.isTTY) {
      process.stdout.write(`${formatLogLine(line, { color: true })}\n`);
    } else {
      process.stdout.write(line);
    }
  },
};

/**
 * Lines logged before initLogger() (config loading, migrations). Replayed into
 * the session file once it opens, so the file tells the whole startup story.
 */
const BOOT_BUFFER_MAX = 500;
let bootBuffer: string[] | null = [];
const bootStream: LineStream = {
  write(line: string): void {
    if (!bootBuffer) return;
    if (bootBuffer.length >= BOOT_BUFFER_MAX) bootBuffer.shift();
    bootBuffer.push(line);
  },
};

let root: pino.Logger = buildRoot(
  [
    { level: envLevel() ?? 'info', stream: consoleStream },
    { level: 'debug', stream: bootStream },
  ],
);
let generation = 0;
let sessionLog: SessionLog | null = null;

function envLevel(): LogLevel | null {
  const raw = process.env['LOG_LEVEL']?.trim().toLowerCase();
  return raw && raw in LEVEL_VALUES ? (raw as LogLevel) : null;
}

function buildRoot(streams: Array<{ level: LogLevel; stream: LineStream }>): pino.Logger {
  const audible = streams.filter((s) => s.level !== 'silent');
  if (audible.length === 0) return pino({ level: 'silent' });
  const lowest = audible.reduce<LogLevel>(
    (min, s) => (LEVEL_VALUES[s.level] < LEVEL_VALUES[min] ? s.level : min),
    'fatal',
  );
  return pino(
    { level: lowest },
    pino.multistream(audible.map((s) => ({ level: s.level as pino.Level, stream: s.stream }))),
  );
}

export interface LoggerOptions {
  /** Terminal / journald level (settings.logLevel). */
  level?: LogLevel | string;
  /** Session log files. Omit to log to the terminal only. */
  files?: SessionLogOptions & { level?: LogLevel };
}

/**
 * Initialise the root logger. Call once at startup, after config is loaded.
 * Accepts a bare level for callers that only want terminal output.
 */
export function initLogger(opts: LoggerOptions | string = 'info'): pino.Logger {
  const options: LoggerOptions = typeof opts === 'string' ? { level: opts } : opts;
  const consoleLevel = normalizeLevel(envLevel() ?? options.level ?? 'info');
  const streams: Array<{ level: LogLevel; stream: LineStream }> = [
    { level: consoleLevel, stream: consoleStream },
  ];

  sessionLog?.close();
  sessionLog = null;
  if (options.files) {
    try {
      sessionLog = new SessionLog(options.files);
      const fileLevel = normalizeLevel(options.files.level ?? 'debug');
      const file = sessionLog;
      streams.push({ level: fileLevel, stream: { write: (line) => file.writeLine(line) } });
      for (const line of bootBuffer ?? []) file.writeLine(line, fileLevel);
    } catch (err) {
      process.stderr.write(
        `[log] could not open the session log file — logging to the terminal only: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      sessionLog = null;
    }
  }
  bootBuffer = null;

  root = buildRoot(streams);
  generation += 1;
  return root;
}

function normalizeLevel(level: string): LogLevel {
  const lower = level.toLowerCase();
  return lower in LEVEL_VALUES ? (lower as LogLevel) : 'info';
}

/** Return the root logger. */
export function getLogger(): pino.Logger {
  return root;
}

/** The live session log (for the logs API and the shutdown footer), if any. */
export function getSessionLog(): SessionLog | null {
  return sessionLog;
}

/** Flush and close the session log file with an end-of-session footer. */
export function closeLogger(reason = 'shutdown'): void {
  sessionLog?.close(reason);
  sessionLog = null;
}

const childCache = new Map<string, { generation: number; logger: pino.Logger }>();

function resolveChild(module: string): pino.Logger {
  const cached = childCache.get(module);
  if (cached && cached.generation === generation) return cached.logger;
  const logger = root.child({ module });
  childCache.set(module, { generation, logger });
  return logger;
}

/**
 * Namespaced child logger — keeps module context in every log line, and
 * follows whatever root initLogger() installed, whenever it was called.
 */
export function childLogger(module: string): pino.Logger {
  return new Proxy(Object.create(null) as pino.Logger, {
    get(_target, prop) {
      const logger = resolveChild(module);
      const value = Reflect.get(logger, prop, logger) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(logger) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolveChild(module), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(resolveChild(module), prop);
    },
  });
}

/** Audit child logger. Every entry carries `audit: true` for easy grepping. */
export const auditLog = {
  write(entry: {
    tool: string;
    project?: string;
    argsHash?: string;
    result: 'ok' | 'rejected' | 'error';
    reason?: string;
  }): void {
    getLogger().info({ audit: true, ...entry }, 'tool_audit');
  },
};

/**
 * Hash arbitrary args for the audit log — we record a fingerprint, not the
 * raw prompt/content, so sensitive project text never lands in the log at info
 * level. Truncated to 16 hex chars (enough to correlate, not enough to reverse).
 */
export function hashArgs(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args))
    .digest('hex')
    .slice(0, 16);
}
