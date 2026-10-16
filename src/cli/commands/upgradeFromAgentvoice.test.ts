import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultHomeDir } from '../../brand.js';
import { planHomeMove, renamedRemote } from './upgradeFromAgentvoice.js';

const scratch = mkdtempSync(join(tmpdir(), 'squeakr-upgrade-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function user(): string {
  const dir = join(scratch, `user-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{}');
}

test('renamedRemote keeps the scheme and the .git suffix', () => {
  assert.equal(
    renamedRemote('https://github.com/dixonSolutions/AgentVoice.git'),
    'https://github.com/dixonSolutions/Squeakr.git',
  );
  assert.equal(renamedRemote('git@github.com:dixonSolutions/AgentVoice.git'), 'git@github.com:dixonSolutions/Squeakr.git');
  assert.equal(renamedRemote('https://github.com/dixonsolutions/agentvoice'), 'https://github.com/dixonSolutions/Squeakr');
  assert.equal(
    renamedRemote('https://github.com/dixonSolutions/Cursor-Voice.git'),
    'https://github.com/dixonSolutions/Squeakr.git',
  );
});

test('renamedRemote leaves forks and the new repo alone', () => {
  assert.equal(renamedRemote('https://github.com/someone/AgentVoice.git'), null);
  assert.equal(renamedRemote('https://github.com/dixonSolutions/Squeakr.git'), null);
});

test('an AgentVoice home is moved to ~/.squeakr', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  assert.deepEqual(planHomeMove(home, {}), {
    kind: 'move',
    from: join(home, '.agentvoice'),
    to: join(home, '.squeakr'),
  });
});

test('a home already moved (symlink left behind) is reported as done', () => {
  const home = user();
  seedHome(join(home, '.squeakr'));
  symlinkSync(join(home, '.squeakr'), join(home, '.agentvoice'), 'dir');
  assert.equal(planHomeMove(home, {}).kind, 'already');
});

test('two real homes are never merged', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  seedHome(join(home, '.squeakr'));
  assert.equal(planHomeMove(home, {}).kind, 'conflict');
});

test('a custom home set by environment variable stays put', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  assert.equal(planHomeMove(home, { AGENTVOICE_HOME: '/srv/bridge' }).kind, 'nothing');
});

test('nothing to move when there was never an AgentVoice home', () => {
  assert.equal(planHomeMove(user(), {}).kind, 'nothing');
});

test('the default home is ~/.agentvoice only until it is upgraded', () => {
  const home = user();
  assert.equal(defaultHomeDir(home), join(home, '.squeakr'));
  seedHome(join(home, '.agentvoice'));
  assert.equal(defaultHomeDir(home), join(home, '.agentvoice'));
  seedHome(join(home, '.squeakr'));
  assert.equal(defaultHomeDir(home), join(home, '.squeakr'));
});
