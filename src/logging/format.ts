/**
 * pino JSON line → one readable text line.
 *
 * Used for both the session .log files and the colored terminal output, so a
 * line reads the same wherever you meet it. journald keeps raw JSON (see
 * log.ts) because that is what `journalctl -o json` tooling expects.
 *
 *   2026-09-23 14:05:12.345 INFO  [server] listening port=8787 host="0.0.0.0"
 *
 * Error objects keep their stack, indented under the line, because a log file
 * without the stack is a log file you cannot debug from.
 */

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const LEVEL_COLORS: Record<number, string> = {
  10: '\x1b[90m',
  20: '\x1b[36m',
  30: '\x1b[32m',
  40: '\x1b[33m',
  50: '\x1b[31m',
  60: '\x1b[41m\x1b[97m',
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** Keys pino writes on every line — rendered in the prefix, never repeated as fields. */
const RESERVED = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'module', 'v']);

export interface FormatOptions {
  color?: boolean;
  /** Render the timestamp as local time (default) or UTC. */
  utc?: boolean;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function formatTimestamp(ms: number, utc = false): string {
  const d = new Date(ms);
  const [y, mo, day, h, mi, s, milli] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  return `${y}-${pad(mo)}-${pad(day)} ${pad(h)}:${pad(mi)}:${pad(s)}.${pad(milli, 3)}`;
}

/** Quote only when a bare value would be ambiguous to read back. */
function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value === '' || /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface SerializedError {
  type?: string;
  message?: string;
  stack?: string;
}

function isSerializedError(value: unknown): value is SerializedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SerializedError).stack === 'string' &&
    typeof (value as SerializedError).message === 'string'
  );
}

/** Format a parsed pino record. */
export function formatLogRecord(record: Record<string, unknown>, opts: FormatOptions = {}): string {
  const level = typeof record['level'] === 'number' ? record['level'] : 30;
  const levelName = (LEVEL_NAMES[level] ?? String(level)).padEnd(5);
  const time = typeof record['time'] === 'number' ? record['time'] : Date.now();
  const module = typeof record['module'] === 'string' ? record['module'] : null;
  const msg = typeof record['msg'] === 'string' ? record['msg'] : '';

  const fields: string[] = [];
  const stacks: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key) || value === undefined) continue;
    if (isSerializedError(value)) {
      fields.push(`${key}=${renderValue(`${value.type ?? 'Error'}: ${value.message}`)}`);
      stacks.push(value.stack!);
      continue;
    }
    fields.push(`${key}=${renderValue(value)}`);
  }

  const ts = formatTimestamp(time, opts.utc);
  const color = opts.color === true;
  const levelText = color ? `${LEVEL_COLORS[level] ?? ''}${levelName}${RESET}` : levelName;
  const tsText = color ? `${DIM}${ts}${RESET}` : ts;
  const moduleText = module ? (color ? ` ${DIM}[${module}]${RESET}` : ` [${module}]`) : '';
  const fieldText = fields.length ? ` ${color ? DIM : ''}${fields.join(' ')}${color ? RESET : ''}` : '';

  let line = `${tsText} ${levelText}${moduleText} ${msg}${fieldText}`;
  for (const stack of stacks) {
    line += '\n' + stack.split('\n').map((l) => `    ${l}`).join('\n');
  }
  return line;
}

/**
 * Format one serialized pino line. Anything that is not a JSON record (a
 * stray console write routed through the stream) passes through verbatim.
 */
export function formatLogLine(line: string, opts: FormatOptions = {}): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    return formatLogRecord(JSON.parse(trimmed) as Record<string, unknown>, opts);
  } catch {
    return trimmed;
  }
}
