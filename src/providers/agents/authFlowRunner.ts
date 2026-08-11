/**
 * Shared plumbing for "spawn the CLI's own login command, scrape the URL and/or
 * one-time code from stdout, resolve when the process exits" — used by every
 * provider whose login flow is CLI-driven (Cursor `login`, Codex `login --device-auth`).
 */

import { spawn } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import { childLogger } from '../../log.js';
import type { AuthCheckResult, AuthFlowId, AuthStartResult } from './types.js';

const log = childLogger('auth-flow');

export interface RunLoginCommandOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Matches the tappable auth URL in combined stdout/stderr. */
  urlPattern: RegExp;
  /** Matches a short one-time code, if this is a device-code flow. */
  codePattern?: RegExp;
  /** How long to wait for the URL/code to appear before giving up (ms). */
  scrapeTimeoutMs?: number;
  /** How long to wait for the process to finish after the URL appears (ms). */
  totalTimeoutMs?: number;
  /** Re-check auth this way once the process exits (covers CLIs that exit 0 either way). */
  verify: () => Promise<AuthCheckResult>;
  /** One sentence of guidance surfaced to the user. */
  instructions: string;
  flowId: AuthFlowId;
}

/**
 * Spawns the login command, waits (briefly) for the URL/code to appear in its
 * output, then returns an AuthStartResult whose `done` promise resolves when
 * the whole login flow (browser round-trip included) finishes.
 */
export async function runLoginCommand(opts: RunLoginCommandOptions): Promise<AuthStartResult> {
  const {
    bin,
    args,
    env,
    cwd,
    urlPattern,
    codePattern,
    scrapeTimeoutMs = 20_000,
    totalTimeoutMs = 5 * 60_000,
    verify,
    instructions,
    flowId,
  } = opts;

  const child = spawn(bin, args, { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = '';
  let url: string | undefined;
  let code: string | undefined;
  let scrapeSettled = false;
  let resolveScrape: (() => void) | null = null;
  const scraped = new Promise<void>((res) => {
    resolveScrape = res;
  });

  function scan(): void {
    const clean = stripAnsi(buffer);
    if (!url) {
      const m = clean.match(urlPattern);
      if (m) url = m[0];
    }
    if (codePattern && !code) {
      const m = clean.match(codePattern);
      if (m) code = m[1] ?? m[0];
    }
    if (url && (!codePattern || code) && !scrapeSettled) {
      scrapeSettled = true;
      resolveScrape?.();
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    scan();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    scan();
  });

  const scrapeTimer = setTimeout(() => {
    if (!scrapeSettled) {
      scrapeSettled = true;
      resolveScrape?.();
    }
  }, scrapeTimeoutMs);

  let cancelled = false;
  const totalTimer = setTimeout(() => {
    if (!child.killed) {
      log.warn({ bin }, 'login flow timed out — killing');
      child.kill('SIGTERM');
    }
  }, totalTimeoutMs);

  const done: Promise<AuthCheckResult> = new Promise((resolve) => {
    child.on('close', (exitCode) => {
      clearTimeout(totalTimer);
      if (cancelled) {
        resolve({ authenticated: false, email: null, detail: 'Login cancelled' });
        return;
      }
      log.info({ bin, exitCode }, 'login command exited — verifying');
      void verify()
        .then(resolve)
        .catch((err) =>
          resolve({
            authenticated: false,
            email: null,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
    });
    child.on('error', (err) => {
      clearTimeout(totalTimer);
      resolve({ authenticated: false, email: null, detail: err.message });
    });
  });

  function cancel(): void {
    cancelled = true;
    clearTimeout(scrapeTimer);
    clearTimeout(totalTimer);
    if (!child.killed) child.kill('SIGTERM');
  }

  await scraped;
  clearTimeout(scrapeTimer);

  return { flow: flowId, url, code, instructions, done, cancel };
}
