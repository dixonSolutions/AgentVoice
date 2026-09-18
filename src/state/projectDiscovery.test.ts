import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDiscoverySettings } from '../config.js';
import { discoverProjectPaths } from './projectDiscovery.js';

const cleanup: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentvoice-discovery-'));
  cleanup.push(root);
  return root;
}

function gitProject(path: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
}

function settings(hotPaths: string[], extra: Partial<ProjectDiscoverySettings> = {}): ProjectDiscoverySettings {
  return {
    enabled: true,
    hotPaths,
    exclude: [],
    requireGit: true,
    watch: false,
    rescanIntervalMs: 60_000,
    ...extra,
  };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('project discovery', () => {
  test('discovers only immediate Git worktrees beneath a hot path', () => {
    const root = fixture();
    gitProject(join(root, 'alpha'));
    mkdirSync(join(root, 'notes'));
    gitProject(join(root, 'container', 'deep-project'));

    const found = discoverProjectPaths(settings([root]));
    assert.deepEqual(found.map((project) => project.path), [join(root, 'alpha')]);
  });

  test('supports nested hot paths without registering their container', () => {
    const root = fixture();
    const nested = join(root, 'work');
    gitProject(join(root, 'top-level'));
    gitProject(join(nested, 'nested-project'));

    const found = discoverProjectPaths(settings([root, nested]));
    assert.deepEqual(
      found.map((project) => project.path),
      [join(nested, 'nested-project'), join(root, 'top-level')].sort(),
    );
  });

  test('honours both bare-name and absolute-path exclusions', () => {
    const root = fixture();
    gitProject(join(root, 'keep'));
    gitProject(join(root, 'skip-by-name'));
    gitProject(join(root, 'skip-by-path'));

    const found = discoverProjectPaths(
      settings([root], { exclude: ['skip-by-name', join(root, 'skip-by-path')] }),
    );
    assert.deepEqual(found.map((project) => project.path), [join(root, 'keep')]);
  });

  test('can include plain directories only when explicitly configured', () => {
    const root = fixture();
    mkdirSync(join(root, 'plain'));

    assert.deepEqual(discoverProjectPaths(settings([root])).map((project) => project.path), []);
    assert.deepEqual(
      discoverProjectPaths(settings([root], { requireGit: false })).map((project) => project.path),
      [join(root, 'plain')],
    );
  });
});
