#!/usr/bin/env node
/**
 * `agentvoice` — the published package's `bin`, and nothing more than a shim.
 *
 * Everything the CLI does lives in src/cli/, built to dist/cli.js, so it is
 * typechecked alongside the bridge and can import what the bridge already
 * knows — install mode, run-mode ports, the systemd unit layout. This file
 * only exists because package.json#bin has to point at a real file with a
 * shebang, and because a missing dist/ deserves a better message than a stack
 * trace about an unresolved module.
 *
 * See docs/35-cli.md.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgRoot, 'dist', 'cli.js');

let cli;
try {
  // pathToFileURL, not a bare path: a Windows absolute path is not a valid
  // module specifier and import() rejects it.
  cli = await import(pathToFileURL(entry).href);
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      `agentvoice: ${entry} is missing — this install is incomplete.\n` +
        '  From a clone:  npm run build\n' +
        '  Otherwise:     npm install -g agentvoice',
    );
    process.exit(1);
  }
  throw err;
}

// main() sets process.exitCode and returns; it never calls process.exit, so
// `run` can hand the process over to the bridge and stdout always drains.
await cli.main(process.argv.slice(2));
