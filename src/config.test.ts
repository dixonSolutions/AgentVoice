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

type Raw = { settings: { voice: { tts: Record<string, unknown> }; workflow: Record<string, unknown> } };
const example = (): Raw =>
  JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as Raw;

test('the agent-speech flag carries over from both pre-Squeakr names', () => {
  const tts = (flags: Record<string, unknown>) => {
    const raw = example();
    delete raw.settings.voice.tts['agentSpeechEnabled'];
    Object.assign(raw.settings.voice.tts, flags);
    migrateRawConfig(raw);
    return raw.settings.voice.tts;
  };
  assert.equal(tts({ agentVoiceEnabled: false })['agentSpeechEnabled'], false);
  assert.equal(tts({ cursorVoiceEnabled: false })['agentSpeechEnabled'], false);
  // The newest name wins, and the old ones are gone afterwards.
  const both = tts({ agentSpeechEnabled: true, agentVoiceEnabled: false });
  assert.equal(both['agentSpeechEnabled'], true);
  assert.equal('agentVoiceEnabled' in both, false);
});

test('a pre-rename speech server keeps its container and model volume', () => {
  const server = (speechServer: Record<string, unknown>) => {
    const raw = example();
    const li = ((raw.settings.workflow['llmIntelligence'] ??= {}) as Record<string, unknown>);
    const audio = ((li['audio'] ??= {}) as Record<string, unknown>);
    audio['speechServer'] = speechServer;
    migrateRawConfig(raw);
    return audio['speechServer'];
  };
  assert.deepEqual(server({ manage: 'container' }), {
    manage: 'container',
    containerName: 'agentvoice-speech',
    modelVolume: 'agentvoice-speech-models',
  });
  // Names the user chose (or the new defaults, once saved) are left alone.
  assert.deepEqual(server({ containerName: 'squeakr-speech', modelVolume: 'mine' }), {
    containerName: 'squeakr-speech',
    modelVolume: 'mine',
  });
});

test('the untouched "cursor listen" default moves to "hey squeaker"; a chosen phrase stays', () => {
  const start = (phrase: string) => {
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as {
      settings: { voice: { wakeWords: { start: string } } };
    };
    raw.settings.voice.wakeWords.start = phrase;
    migrateRawConfig(raw);
    return raw.settings.voice.wakeWords.start;
  };
  assert.equal(start('cursor listen'), 'hey squeaker');
  assert.equal(start('Cursor Listen '), 'hey squeaker');
  assert.equal(start('computer listen'), 'computer listen');
});
