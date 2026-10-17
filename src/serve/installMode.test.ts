import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classifyNpmRoot, LEGACY_PACKAGE_NAMES, legacyPackageAt, npmProjectDir, PACKAGE_NAME } from './installMode.js';

const scratch = mkdtempSync(join(tmpdir(), 'squeaky-installmode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function pkgUnder(prefix: string): string {
  const root = join(prefix, 'node_modules', 'squeaky');
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

test('the pre-rename scoped package still classifies as a global install', () => {
  const root = join(scratch, 'legacy', 'lib', 'node_modules', '@ratitisrad', 'agentvoice');
  mkdirSync(root, { recursive: true });
  assert.deepEqual(classifyNpmRoot(root), { global: true, npx: false });
});

test('an install running from a pre-rename package is recognised by its path', () => {
  assert.equal(legacyPackageAt(join(scratch, 'lib', 'node_modules', 'squeakr')), 'squeakr');
  assert.equal(
    legacyPackageAt(join(scratch, 'lib', 'node_modules', '@ratitisrad', 'agentvoice')),
    '@ratitisrad/agentvoice',
  );
  assert.equal(legacyPackageAt('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\squeakr'), 'squeakr');
  assert.equal(legacyPackageAt(join(scratch, 'lib', 'node_modules', PACKAGE_NAME)), null);
  // A clone that happens to be called squeakr is not an npm install of it.
  assert.equal(legacyPackageAt(join(scratch, 'src', 'squeakr')), null);
  assert.equal(legacyPackageAt(join(scratch, 'lib', 'node_modules', 'agentvoice')), null);
});

test('no legacy package name is the current one, and squeaky itself is never one', () => {
  for (const name of LEGACY_PACKAGE_NAMES) assert.notEqual(name, PACKAGE_NAME);
  assert.ok(!(LEGACY_PACKAGE_NAMES as readonly string[]).includes('squeaky'));
});
