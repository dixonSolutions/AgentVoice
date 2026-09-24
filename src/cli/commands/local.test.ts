import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProjectDetails } from '../projectDetails.js';
import { deepMerge, localConfig } from './local.js';

const project: ProjectDetails = {
  path: '/code/app',
  name: 'app',
  description: 'An app',
  aliases: ['the app'],
  git: true,
  sources: { name: 'package.json', description: 'package.json' },
};

test('localConfig keeps settings but pins projects, port, hosting and logging', () => {
  const base = {
    settings: {
      agentClient: 'claude-code',
      runMode: 'serve',
      runModes: { serve: { backendPort: 8787, publicBaseUrl: 'https://host.ts.net' } },
      hosting: { provider: 'tailscale' },
      projectDiscovery: { enabled: true, hotPaths: ['~/Projects'] },
      logging: { files: true, fileLevel: 'debug' },
      serve: { branch: 'main', repoDir: '/src' },
    },
    projects: [{ name: 'other', path: '/other' }],
  };
  const cfg = localConfig(base, project, 5190) as unknown as {
    settings: typeof base.settings & { hosting: unknown; projectDiscovery: { enabled: boolean }; logging: { files: boolean } };
    projects: Array<Record<string, unknown>>;
  };
  assert.equal(cfg.settings.agentClient, 'claude-code');
  assert.deepEqual(cfg.settings.runModes.serve, { backendPort: 5190 } as unknown);
  assert.deepEqual(cfg.settings.hosting, { provider: 'local' });
  assert.equal(cfg.settings.projectDiscovery.enabled, false);
  assert.equal(cfg.settings.logging.files, false);
  assert.equal((cfg.settings.serve as { repoDir?: string }).repoDir, undefined);
  assert.deepEqual(cfg.projects.map((p) => p['path']), ['/code/app']);
  // The real config object is untouched.
  assert.equal(base.settings.runModes.serve.backendPort, 8787);
  assert.equal(base.projects.length, 1);
});

test('deepMerge layers settings over defaults without dropping nested keys', () => {
  const merged = deepMerge(
    { settings: { voice: { wake: 'hey' }, agentClient: 'codex', list: [1, 2] } },
    { settings: { agentClient: 'cursor', list: [3] } },
  );
  assert.deepEqual(merged, { settings: { voice: { wake: 'hey' }, agentClient: 'cursor', list: [3] } });
});
