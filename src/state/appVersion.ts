/**
 * Package version + git short SHA for /healthz and Config UI.
 *
 * Uses process.cwd() (service working directory = repo root), not import.meta.url —
 * tsup bundles into dist/index.js so relative paths from the module URL are wrong.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: { appVersion: string; gitCommit: string | null } | null = null;

function readPackageVersion(root: string): string {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitShortSha(root: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3_000,
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** Cached at first call — version does not change without process restart. */
export function getAppVersionInfo(): { appVersion: string; gitCommit: string | null } {
  if (!cached) {
    const root = process.cwd();
    cached = {
      appVersion: readPackageVersion(root),
      gitCommit: readGitShortSha(root),
    };
  }
  return cached;
}
