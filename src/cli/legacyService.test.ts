import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LEGACY_GENERATIONS, renameLegacyUnits } from './legacyService.js';
import { LAUNCHD_LABEL, SERVICE_UNIT, WINDOWS_SERVICE } from './service.js';

test('AgentVoice unit names map to their Squeaky names, in names and in unit files', () => {
  assert.equal(renameLegacyUnits('agentvoice.service'), 'squeaky.service');
  assert.equal(renameLegacyUnits('agentvoice-watch.path'), 'squeaky-watch.path');
  assert.equal(renameLegacyUnits('agentvoice-caddy.service'), 'squeaky-caddy.service');
  assert.equal(
    renameLegacyUnits('[Path]\nUnit=agentvoice-watch.service\n[Unit]\nAfter=agentvoice.service\n'),
    '[Path]\nUnit=squeaky-watch.service\n[Unit]\nAfter=squeaky.service\n',
  );
  // Paths are not unit names: a home or TLS directory stays where it is.
  assert.equal(renameLegacyUnits('WorkingDirectory=/home/a/.agentvoice'), 'WorkingDirectory=/home/a/.agentvoice');
});

test('Squeakr unit names map to their Squeaky names too', () => {
  assert.equal(renameLegacyUnits('squeakr.service'), 'squeaky.service');
  assert.equal(renameLegacyUnits('squeakr-watch.path'), 'squeaky-watch.path');
  assert.equal(renameLegacyUnits('squeakr-tunnel.service'), 'squeaky-tunnel.service');
  assert.equal(
    renameLegacyUnits('[Service]\nExecStart=/usr/bin/systemctl --user restart squeakr.service\nWorkingDirectory=%h/.squeakr\n'),
    '[Service]\nExecStart=/usr/bin/systemctl --user restart squeaky.service\nWorkingDirectory=%h/.squeakr\n',
  );
  // The launcher a unit runs is a path too, not a unit.
  assert.equal(renameLegacyUnits('ExecStart=node /opt/x/bin/squeakr.mjs run'), 'ExecStart=node /opt/x/bin/squeakr.mjs run');
  // Already-renamed names are left alone.
  assert.equal(renameLegacyUnits('squeaky-watch.path'), 'squeaky-watch.path');
});

test('both earlier names are recognised, newest first, and none is the current one', () => {
  assert.deepEqual(
    LEGACY_GENERATIONS.map((g) => [g.unit, g.launchdLabel, g.windowsService]),
    [
      ['squeakr.service', 'com.squeakr.bridge', 'Squeakr'],
      ['agentvoice.service', 'com.agentvoice.bridge', 'AgentVoice'],
    ],
  );
  for (const gen of LEGACY_GENERATIONS) {
    assert.notEqual(gen.unit, SERVICE_UNIT);
    assert.notEqual(gen.launchdLabel, LAUNCHD_LABEL);
    // sc.exe names are case-insensitive.
    assert.notEqual(gen.windowsService.toLowerCase(), WINDOWS_SERVICE.toLowerCase());
    assert.deepEqual(gen.companions.map(renameLegacyUnits), [
      'squeaky-watch.path',
      'squeaky-watch.service',
      'squeaky-tunnel.service',
      'squeaky-caddy.service',
    ]);
  }
});
