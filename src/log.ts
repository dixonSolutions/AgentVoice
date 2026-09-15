/**
 * Structured logging via pino. A single logger instance is created at startup
 * and shared across the bridge. Audit events get a dedicated child logger that
 * adds an `audit: true` marker so they can be separated in log queries.
 */

import pino from 'pino';
import { createHash } from 'node:crypto';

let _logger: pino.Logger | null = null;

/** Initialise the root logger. Must be called once at startup before getLogger(). */
export function initLogger(level: string = 'info'): pino.Logger {
  _logger = pino({
    level,
    // Pretty-print in dev (TTY), raw JSON in production (journald).
    ...(process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
  return _logger;
}

/**
 * Return the root logger, initialising with defaults if not yet set up.
 *
 * `LOG_LEVEL` is honoured for the implicit case so `npm test` (which never
 * calls `initLogger`) does not bury assertion output in JSON log lines.
 */
export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  }
  return _logger;
}

/** Namespaced child logger — keeps module context in every log line. */
export function childLogger(module: string): pino.Logger {
  return getLogger().child({ module });
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
