// Two bundles: the extension host (Node, CommonJS as VS Code requires) and the
// panel webview (browser). Both pull the shared client from ../packages/client.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const clientAlias = { '@agentvoice/client': resolve(here, '../packages/client/src/index.ts') };

// Voice cues ship with the extension but are owned by the web app, so copy
// rather than fork them — a second set would drift the moment one is retuned.
function copyCues() {
  const from = resolve(here, '../web/public/sounds');
  const to = resolve(here, 'media/sounds');
  if (!existsSync(from)) {
    console.warn('[cues] web/public/sounds missing — the panel will run silent');
    return;
  }
  mkdirSync(to, { recursive: true });
  for (const file of ['listening.mp3', 'sent.mp3', 'cancel.mp3', 'error.mp3', 'LICENSE.txt']) {
    const src = resolve(from, file);
    if (existsSync(src)) copyFileSync(src, resolve(to, file));
  }
  console.log('[cues] copied voice cues into media/sounds');
}
copyCues();

const host = {
  entryPoints: [resolve(here, 'src/extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: resolve(here, 'dist/extension.js'),
  external: ['vscode'],
  sourcemap: true,
  alias: clientAlias,
  logLevel: 'info',
};

const webview = {
  entryPoints: [resolve(here, 'src/webview/main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: resolve(here, 'dist/webview.js'),
  sourcemap: true,
  alias: clientAlias,
  logLevel: 'info',
};

// Integration test suite — runs inside the extension host under @vscode/test-electron.
const tests = {
  entryPoints: [resolve(here, 'src/test/suite.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: resolve(here, 'dist/test/suite.js'),
  external: ['vscode', 'mocha'],
  sourcemap: true,
  alias: clientAlias,
  logLevel: 'info',
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview), esbuild.build(tests)]);
}
