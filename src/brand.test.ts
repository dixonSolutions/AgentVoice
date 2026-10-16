import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandEnv, brandEnvKeys } from './brand.js';

test('brandEnv prefers SQUEAKR_ over the pre-rename AGENTVOICE_', () => {
  assert.equal(brandEnv('HOME', { SQUEAKR_HOME: '/new', AGENTVOICE_HOME: '/old' }), '/new');
});

test('brandEnv falls back to AGENTVOICE_ so pre-rename units keep working', () => {
  assert.equal(brandEnv('HOME', { AGENTVOICE_HOME: '/old' }), '/old');
});

test('brandEnv treats an empty value as unset, like ${X:-…} in the shell scripts', () => {
  assert.equal(brandEnv('HOME', { SQUEAKR_HOME: '', AGENTVOICE_HOME: '/old' }), '/old');
  assert.equal(brandEnv('HOME', { SQUEAKR_HOME: '', AGENTVOICE_HOME: '' }), undefined);
  assert.equal(brandEnv('HOME', {}), undefined);
});

test('brandEnvKeys lists the current spelling first', () => {
  assert.deepEqual(brandEnvKeys('LOG_DIR'), ['SQUEAKR_LOG_DIR', 'AGENTVOICE_LOG_DIR']);
});
