/** This package's root — where dist/, web/dist/ and the app icon live, installed or in a clone. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null | undefined;

export function packageRoot(): string | null {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@ratitisrad/agentvoice') {
          cached = dir;
          return dir;
        }
      } catch {
        // not ours — keep climbing
      }
    }
    dir = dirname(dir);
  }
  cached = null;
  return null;
}

/** The AgentVoice app icon (512 px PNG) — the built web client's, else the source's. */
export function appIconPath(): string | null {
  const root = packageRoot();
  if (!root) return null;
  for (const rel of ['web/dist/icon-512.png', 'web/public/icon-512.png']) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}
