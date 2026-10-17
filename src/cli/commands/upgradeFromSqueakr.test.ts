import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultHomeDir } from '../../brand.js';
import { planHomeMove, renamedRemote } from './upgradeFromSqueakr.js';

const scratch = mkdtempSync(join(tmpdir(), 'squeaky-upgrade-'));
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
    'https://github.com/dixonSolutions/Squeaky.git',
  );
  assert.equal(renamedRemote('git@github.com:dixonSolutions/AgentVoice.git'), 'git@github.com:dixonSolutions/Squeaky.git');
  assert.equal(renamedRemote('https://github.com/dixonsolutions/agentvoice'), 'https://github.com/dixonSolutions/Squeaky');
  assert.equal(
    renamedRemote('https://github.com/dixonSolutions/Cursor-Voice.git'),
    'https://github.com/dixonSolutions/Squeaky.git',
  );
});

test('renamedRemote switches a Squeakr-era clone too', () => {
  assert.equal(renamedRemote('https://github.com/dixonSolutions/Squeakr.git'), 'https://github.com/dixonSolutions/Squeaky.git');
  assert.equal(renamedRemote('git@github.com:dixonSolutions/Squeakr'), 'git@github.com:dixonSolutions/Squeaky');
});

test('renamedRemote leaves forks and the new repo alone', () => {
  assert.equal(renamedRemote('https://github.com/someone/AgentVoice.git'), null);
  assert.equal(renamedRemote('https://github.com/someone/Squeakr.git'), null);
  assert.equal(renamedRemote('https://github.com/dixonSolutions/Squeaky.git'), null);
});

test('an AgentVoice home is moved to ~/.squeaky', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  assert.deepEqual(planHomeMove(home, {}), {
    kind: 'move',
    from: join(home, '.agentvoice'),
    to: join(home, '.squeaky'),
    relink: [],
  });
});

test('a Squeakr home is moved to ~/.squeaky', () => {
  const home = user();
  seedHome(join(home, '.squeakr'));
  assert.deepEqual(planHomeMove(home, {}), {
    kind: 'move',
    from: join(home, '.squeakr'),
    to: join(home, '.squeaky'),
    relink: [],
  });
});

test('after the AgentVoice → Squeakr upgrade, ~/.squeakr moves and ~/.agentvoice is re-pointed', () => {
  const home = user();
  seedHome(join(home, '.squeakr'));
  symlinkSync(join(home, '.squeakr'), join(home, '.agentvoice'), 'dir');
  assert.deepEqual(planHomeMove(home, {}), {
    kind: 'move',
    from: join(home, '.squeakr'),
    to: join(home, '.squeaky'),
    relink: [join(home, '.agentvoice')],
  });
});

test('~/.squeakr linked to ~/.agentvoice moves the real directory and re-points the link', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  symlinkSync(join(home, '.agentvoice'), join(home, '.squeakr'), 'dir');
  assert.deepEqual(planHomeMove(home, {}), {
    kind: 'move',
    from: join(home, '.agentvoice'),
    to: join(home, '.squeaky'),
    relink: [join(home, '.squeakr')],
  });
});

test('an old name linked somewhere else is a home placed on purpose, left alone', () => {
  const home = user();
  const elsewhere = join(home, 'srv', 'bridge');
  seedHome(elsewhere);
  symlinkSync(elsewhere, join(home, '.squeakr'), 'dir');
  // A stale AgentVoice home must not be moved in front of the one in use.
  seedHome(join(home, '.agentvoice'));
  assert.equal(planHomeMove(home, {}).kind, 'nothing');
});

test('the newest old home in use wins over a stale older one', () => {
  const home = user();
  seedHome(join(home, '.squeakr'));
  seedHome(join(home, '.agentvoice'));
  const plan = planHomeMove(home, {});
  assert.equal(plan.kind, 'move');
  assert.equal(plan.kind === 'move' && plan.from, join(home, '.squeakr'));
});

test('a home already moved (symlinks left behind) is reported as done', () => {
  const home = user();
  seedHome(join(home, '.squeaky'));
  symlinkSync(join(home, '.squeaky'), join(home, '.agentvoice'), 'dir');
  assert.equal(planHomeMove(home, {}).kind, 'already');
  symlinkSync(join(home, '.squeaky'), join(home, '.squeakr'), 'dir');
  assert.equal(planHomeMove(home, {}).kind, 'already');
});

test('two real homes are never merged', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  seedHome(join(home, '.squeaky'));
  assert.equal(planHomeMove(home, {}).kind, 'conflict');
  const other = user();
  seedHome(join(other, '.squeakr'));
  seedHome(join(other, '.squeaky'));
  assert.equal(planHomeMove(other, {}).kind, 'conflict');
});

test('an empty leftover old directory next to a ~/.squeaky in use is not a conflict', () => {
  const home = user();
  mkdirSync(join(home, '.squeakr', 'vosk'), { recursive: true });
  seedHome(join(home, '.squeaky'));
  assert.equal(planHomeMove(home, {}).kind, 'already');
});

test('an old directory without state (a clone is its own home) still moves', () => {
  const home = user();
  mkdirSync(join(home, '.squeakr', 'vosk'), { recursive: true });
  assert.equal(planHomeMove(home, {}).kind, 'move');
});

test('a custom home set by environment variable stays put, under any name', () => {
  const home = user();
  seedHome(join(home, '.agentvoice'));
  assert.equal(planHomeMove(home, { AGENTVOICE_HOME: '/srv/bridge' }).kind, 'nothing');
  assert.equal(planHomeMove(home, { SQUEAKR_HOME: '/srv/bridge' }).kind, 'nothing');
  assert.equal(planHomeMove(home, { SQUEAKY_HOME: '/srv/bridge' }).kind, 'nothing');
  // Pointing at the default old home is not custom: it still moves.
  assert.equal(planHomeMove(home, { AGENTVOICE_HOME: join(home, '.agentvoice') }).kind, 'move');
});

test('nothing to move when there was never an older home', () => {
  assert.equal(planHomeMove(user(), {}).kind, 'nothing');
});

test('the default home is the newest old one only until it is upgraded', () => {
  const home = user();
  assert.equal(defaultHomeDir(home), join(home, '.squeaky'));
  seedHome(join(home, '.agentvoice'));
  assert.equal(defaultHomeDir(home), join(home, '.agentvoice'));
  seedHome(join(home, '.squeakr'));
  assert.equal(defaultHomeDir(home), join(home, '.squeakr'));
  seedHome(join(home, '.squeaky'));
  assert.equal(defaultHomeDir(home), join(home, '.squeaky'));
});
