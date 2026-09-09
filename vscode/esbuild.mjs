// Two bundles: the extension host (Node, CommonJS as VS Code requires) and the
// panel webview (browser). Both pull the shared client from ../packages/client.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const clientAlias = { '@agentvoice/client': resolve(here, '../packages/client/src/index.ts') };

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
