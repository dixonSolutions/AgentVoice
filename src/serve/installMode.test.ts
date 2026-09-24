import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classifyNpmRoot, npmProjectDir, PACKAGE_NAME } from './installMode.js';

const scratch = mkdtempSync(join(tmpdir(), 'agentvoice-installmode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function pkgUnder(prefix: string): string {
  const root = join(prefix, 'node_modules', '@ratitisrad', 'agentvoice');
  mkdirSync(root, { recursive: true });
  return root;
}

test('PACKAGE_NAME matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string;
  };
  assert.equal(PACKAGE_NAME, pkg.name);
});

test('a prefix without package.json is a global install', () => {
  const root = pkgUnder(join(scratch, 'nvm', 'lib'));
  assert.deepEqual(classifyNpmRoot(root), { global: true, npx: false });
});

test('a prefix with package.json is a local dependency', () => {
  const project = join(scratch, 'project');
  const root = pkgUnder(project);
  writeFileSync(join(project, 'package.json'), '{}');
  assert.deepEqual(classifyNpmRoot(root), { global: false, npx: false });
  assert.equal(npmProjectDir(root), project);
});

test('the npx cache is npx, even though it has a package.json', () => {
  const cache = join(scratch, '.npm', '_npx', 'abc123');
  const root = pkgUnder(cache);
  writeFileSync(join(cache, 'package.json'), '{}');
  assert.deepEqual(classifyNpmRoot(root), { global: false, npx: true });
});
