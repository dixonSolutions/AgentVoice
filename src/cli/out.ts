/**
 * Terminal output for the management CLI.
 *
 * Two rules shape this file. Machine consumers must never have to strip escape
 * codes, so colour is dropped the moment stdout stops being a TTY (or NO_COLOR
 * is set). And `status` is meant to be read at a glance rather than parsed, so
 * its values line up in a column — `--json` is there for anything that wants
 * structure.
 */

const COLOUR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];

function paint(code: string, text: string): string {
  return COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (t: string): string => paint('1', t);
export const dim = (t: string): string => paint('2', t);
export const red = (t: string): string => paint('31', t);
export const green = (t: string): string => paint('32', t);
export const yellow = (t: string): string => paint('33', t);
export const cyan = (t: string): string => paint('36', t);

export type Mark = 'ok' | 'warn' | 'fail' | 'none';

/** Leading glyph for a check result. Colour repeats what the word already says. */
export function mark(m: Mark): string {
  switch (m) {
    case 'ok':
      return green('ok  ');
    case 'warn':
      return yellow('warn');
    case 'fail':
      return red('fail');
    default:
      return '    ';
  }
}

export interface Row {
  label: string;
  value: string;
  /** Extra lines hung under the value, aligned with it. */
  notes?: string[];
}

/** Key/value block with every value in one column — the `status` house style. */
export function renderRows(rows: Row[], indent = '  '): string {
  const width = rows.reduce((max, r) => Math.max(max, r.label.length), 0);
  const out: string[] = [];
  for (const row of rows) {
    out.push(`${indent}${dim(row.label.padEnd(width))}  ${row.value}`);
    for (const note of row.notes ?? []) {
      out.push(`${indent}${' '.repeat(width)}  ${dim(note)}`);
    }
  }
  return out.join('\n');
}

export function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Diagnostics go to stderr, so `agentvoice token` can be piped somewhere and
 * `--json` output stays a single parseable document.
 */
export function note(line = ''): void {
  process.stderr.write(`${line}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${red('agentvoice:')} ${message}\n`);
}
