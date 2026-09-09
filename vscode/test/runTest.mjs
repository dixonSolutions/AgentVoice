// Downloads a VS Code build (cached in vscode/.vscode-test) and runs the
// integration suite inside it against the bridge given by
// AGENTVOICE_BRIDGE_URL / AGENTVOICE_TOKEN (defaults: the dev bridge on :5089
// and APP_TOKEN from the repo's .env). Set AGENTVOICE_LIVE=1 to also run the
// live turn + permission-prompt test (needs a signed-in agent CLI).
//
// Headless: `xvfb-run -a node test/runTest.mjs`.
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, '..');
const extensionTestsPath = resolve(here, '../dist/test/suite.js');
const repoRoot = resolve(here, '../..');
const workspace = process.env.AGENTVOICE_TEST_WORKSPACE ?? repoRoot;

function tokenFromEnvFile() {
  const envPath = resolve(repoRoot, '.env');
  if (!existsSync(envPath)) return '';
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('APP_TOKEN='));
  return line ? line.slice('APP_TOKEN='.length).trim() : '';
}

const token = process.env.AGENTVOICE_TOKEN || tokenFromEnvFile();
if (!token) {
  console.error('No AGENTVOICE_TOKEN and no APP_TOKEN in .env — cannot connect to a bridge.');
  process.exit(2);
}

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-workspace-trust', '--password-store=basic', '--disable-extensions'],
    extensionTestsEnv: {
      AGENTVOICE_TOKEN: token,
      AGENTVOICE_BRIDGE_URL: process.env.AGENTVOICE_BRIDGE_URL ?? 'http://127.0.0.1:5089',
      AGENTVOICE_LIVE: process.env.AGENTVOICE_LIVE ?? '',
    },
  });
} catch (err) {
  console.error('integration tests failed:', err);
  process.exit(1);
}
