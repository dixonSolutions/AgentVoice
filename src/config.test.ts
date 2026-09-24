import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { migrateRawConfig } from './config.js';

// Every first run seeds config.json from this file. If a migration touches it,
// a brand-new install opens with "Migrated config — …" about a file it just
// wrote — the example has fallen behind the schema.
test('config.example.json needs no migration', () => {
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as unknown;
  const before = JSON.stringify(raw);
  assert.equal(JSON.stringify(migrateRawConfig(structuredClone(raw))), before);
});
