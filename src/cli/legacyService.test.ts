import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renameLegacyUnits } from './legacyService.js';

test('AgentVoice unit names map to their Squeakr names, in names and in unit files', () => {
  assert.equal(renameLegacyUnits('agentvoice.service'), 'squeakr.service');
  assert.equal(renameLegacyUnits('agentvoice-watch.path'), 'squeakr-watch.path');
  assert.equal(renameLegacyUnits('agentvoice-caddy.service'), 'squeakr-caddy.service');
  assert.equal(
    renameLegacyUnits('[Path]\nUnit=agentvoice-watch.service\n[Unit]\nAfter=agentvoice.service\n'),
    '[Path]\nUnit=squeakr-watch.service\n[Unit]\nAfter=squeakr.service\n',
  );
  // Paths are not unit names: a home or TLS directory stays where it is.
  assert.equal(renameLegacyUnits('WorkingDirectory=/home/a/.agentvoice'), 'WorkingDirectory=/home/a/.agentvoice');
});
