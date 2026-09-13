/**
 * "What version am I, and is there a newer one" — asked two different ways.
 *
 * A clone answers with a branch, a commit, and how far it has drifted from its
 * upstream. An npm install answers with a semver string and whatever the
 * registry currently calls `latest`. detectInstallMode() decides which question
 * is even meaningful; see src/serve/installMode.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './exec.js';

export function packageVersion(root: string): string {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface GitVersion {
  branch: string | null;
  commit: string | null;
  /** Short subject of HEAD, for a bit of context in `status`. */
  subject: string | null;
  dirty: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

/**
 * Read the clone's position without touching the network. ahead/behind are
 * therefore relative to the last `git fetch`, which `status` says out loud —
 * a status command that silently hit the network would be a surprise.
 */
export async function gitVersion(root: string): Promise<GitVersion | null> {
  if (!existsSync(join(root, '.git'))) return null;

  const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (branch.code !== 0) return null;

  const commit = await capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  const subject = await capture('git', ['log', '-1', '--pretty=%s'], { cwd: root });
  const porcelain = await capture('git', ['status', '--porcelain'], { cwd: root });
  const upstream = await capture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root,
  });

  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream.code === 0) {
    // --left-right --count prints "<only in HEAD>\t<only in upstream>".
    const counts = await capture('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
      cwd: root,
    });
    if (counts.code === 0) {
      const [left, right] = counts.stdout.trim().split(/\s+/);
      ahead = Number(left);
      behind = Number(right);
      if (!Number.isFinite(ahead)) ahead = null;
      if (!Number.isFinite(behind)) behind = null;
    }
  }

  return {
    branch: branch.stdout.trim() || null,
    commit: commit.code === 0 ? commit.stdout.trim() || null : null,
    subject: subject.code === 0 ? subject.stdout.trim() || null : null,
    dirty: porcelain.code === 0 && porcelain.stdout.trim().length > 0,
    upstream: upstream.code === 0 ? upstream.stdout.trim() || null : null,
    ahead,
    behind,
  };
}

/**
 * Ask the registry what `latest` is. Only ever called for npm installs — a
 * clone has no registry version to compare against — and always with a short
 * timeout, because `status` on a laptop with no network should still print.
 */
export async function latestOnRegistry(
  name: string,
  timeoutMs = 3000,
): Promise<{ version: string | null; error: string | null }> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    // 404 is a real answer, not a network problem: the name is unpublished, or
    // private to a registry this machine is not authenticated against.
    if (res.status === 404) return { version: null, error: `${name} is not on this registry` };
    if (!res.ok) return { version: null, error: `registry returned HTTP ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return { version: body.version?.trim() || null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { version: null, error: message.includes('timed out') ? 'registry timed out' : message };
  }
}

/** Semver-ish comparison, enough to answer "is latest newer than installed". */
export function isNewer(latest: string, installed: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number(part) || 0);
  const a = parse(latest);
  const b = parse(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
