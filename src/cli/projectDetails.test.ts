import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectProjectDetails, readmeSummary, slugify } from './projectDetails.js';

const scratch = mkdtempSync(join(tmpdir(), 'agentvoice-details-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function dir(name: string, files: Record<string, string>): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  return path;
}

test('slugify matches config.json name rules', () => {
  assert.equal(slugify('My Cool.App'), 'my-cool-app');
  assert.equal(slugify('snake_case'), 'snake_case');
  assert.equal(slugify('---'), 'project');
});

test('readmeSummary skips headings, badges and fences and strips markdown', () => {
  const text = [
    '<p align="center"><img src="x"></p>',
    '# Title',
    '[![build](b.svg)](ci)',
    '```bash',
    'npm i',
    '```',
    'A **fast** tool for [voice](https://x) control.',
    'Second line.',
    '',
    'Ignored paragraph.',
  ].join('\n');
  assert.equal(readmeSummary(text), 'A fast tool for voice control. Second line.');
  assert.equal(readmeSummary('# Only a heading\n'), null);
});

test('package.json supplies name (scope dropped) and description', async () => {
  const path = dir('web-app', {
    'package.json': JSON.stringify({ name: '@acme/VoiceKit', description: 'Voice kit for things' }),
    'README.md': 'Not used when package.json has a description.',
  });
  const d = await detectProjectDetails(path);
  assert.equal(d.name, 'voicekit');
  assert.equal(d.description, 'Voice kit for things');
  assert.deepEqual(d.sources, { name: 'package.json', description: 'package.json' });
  assert.ok(d.aliases.includes('web app'));
  assert.ok(d.aliases.includes('voice kit'));
});

test('Cargo.toml and README fallbacks', async () => {
  const path = dir('rusty', {
    'Cargo.toml': '[package]\nname = "rusty_tool"\nversion = "0.1.0"\n\n[dependencies]\nname = "nope"\n',
    'README.md': '# rusty\n\nRust thing that does stuff.\n',
  });
  const d = await detectProjectDetails(path);
  assert.equal(d.name, 'rusty_tool');
  assert.equal(d.description, 'Rust thing that does stuff.');
  assert.equal(d.sources.description, 'README');
});

test('a bare folder falls back to its name', async () => {
  const d = await detectProjectDetails(dir('Plain Folder', {}));
  assert.equal(d.name, 'plain-folder');
  assert.equal(d.description, null);
  assert.equal(d.git, false);
});
