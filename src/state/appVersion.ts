/**
 * Package version + git short SHA for /healthz and Config UI.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

let cached: { appVersion: string; gitCommit: string | null } | null = null;

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitShortSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
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
    cached = {
      appVersion: readPackageVersion(),
      gitCommit: readGitShortSha(),
    };
  }
  return cached;
}
