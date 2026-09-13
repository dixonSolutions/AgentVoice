/**
 * A flag parser small enough to read in one sitting.
 *
 * No dependency, because the CLI ships inside the bridge tarball and every
 * runtime dependency there is one more thing that can fail to install on a
 * user's machine. The grammar is deliberately narrow: long flags, a couple of
 * single-letter aliases, and `--` to stop parsing so `update` can hand the rest
 * straight to scripts/update.sh.
 */

export interface Parsed {
  /** Flags that take a value: `--branch main` or `--branch=main`. */
  values: Map<string, string>;
  /** Flags that do not: `--json`, `-f`. */
  switches: Set<string>;
  /** Everything that was not a flag, in order. */
  positionals: string[];
  /** Everything after a bare `--`, unparsed. */
  rest: string[];
}

export interface ArgSpec {
  /** Long names that consume the next argv entry as their value. */
  valueFlags?: string[];
  /** Single-letter alias → long name, e.g. `n` → `lines`. */
  aliases?: Record<string, string>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], spec: ArgSpec = {}): Parsed {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const aliases = spec.aliases ?? {};
  const parsed: Parsed = {
    values: new Map(),
    switches: new Set(),
    positionals: [],
    rest: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (arg === '--') {
      parsed.rest = argv.slice(i + 1);
      break;
    }

    if (!arg.startsWith('-') || arg === '-') {
      parsed.positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const raw = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const name = raw.startsWith('--')
      ? raw.slice(2)
      : (aliases[raw.slice(1)] ?? raw.slice(1));

    if (!name) throw new UsageError(`unrecognised argument "${arg}"`);

    if (valueFlags.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      parsed.values.set(name, value);
      continue;
    }

    if (inline !== null) throw new UsageError(`--${name} does not take a value`);
    parsed.switches.add(name);
  }

  return parsed;
}

/** Reject anything the command does not understand instead of ignoring it. */
export function rejectUnknown(parsed: Parsed, known: string[]): void {
  const allowed = new Set(known);
  for (const flag of parsed.switches) {
    if (!allowed.has(flag)) throw new UsageError(`unknown option --${flag}`);
  }
  for (const flag of parsed.values.keys()) {
    if (!allowed.has(flag)) throw new UsageError(`unknown option --${flag}`);
  }
}

export function intFlag(parsed: Parsed, name: string, fallback: number): number {
  const raw = parsed.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}
