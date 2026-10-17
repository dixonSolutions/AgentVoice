import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandEnv, brandEnvKeys } from './brand.js';

test('brandEnv prefers SQUEAKY_ over the pre-rename SQUEAKR_ and AGENTVOICE_', () => {
  assert.equal(brandEnv('HOME', { SQUEAKY_HOME: '/new', SQUEAKR_HOME: '/mid', AGENTVOICE_HOME: '/old' }), '/new');
  assert.equal(brandEnv('HOME', { SQUEAKR_HOME: '/mid', AGENTVOICE_HOME: '/old' }), '/mid');
});

test('brandEnv falls back to AGENTVOICE_ so pre-rename units keep working', () => {
  assert.equal(brandEnv('HOME', { AGENTVOICE_HOME: '/old' }), '/old');
});

test('brandEnv treats an empty value as unset, like ${X:-…} in the shell scripts', () => {
  assert.equal(brandEnv('HOME', { SQUEAKY_HOME: '', AGENTVOICE_HOME: '/old' }), '/old');
  assert.equal(brandEnv('HOME', { SQUEAKY_HOME: '', AGENTVOICE_HOME: '' }), undefined);
  assert.equal(brandEnv('HOME', {}), undefined);
});

test('brandEnvKeys lists the current spelling first', () => {
  assert.deepEqual(brandEnvKeys('LOG_DIR'), ['SQUEAKY_LOG_DIR', 'SQUEAKR_LOG_DIR', 'AGENTVOICE_LOG_DIR']);
});
