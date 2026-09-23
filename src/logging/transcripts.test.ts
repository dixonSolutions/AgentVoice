import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  closeTranscripts,
  configureTranscripts,
  currentTranscriptPath,
  recordAgentSpeech,
  recordNarration,
  recordUserTurn,
  transcriptClientConnected,
  transcriptClientDisconnected,
} from './transcripts.js';

const roots: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function configure(graceMs = 40): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentvoice-transcripts-'));
  roots.push(dir);
  configureTranscripts({
    enabled: true,
    dir,
    keepPlain: 5,
    maxFileMb: 0,
    retentionDays: 0,
    graceMs,
    describe: () => ({ agent: 'Stub', workflow: 'agent_native', input: 'stream' }),
  });
  return dir;
}

beforeEach(() => closeTranscripts('test reset'));
after(() => {
  closeTranscripts('test end');
  configureTranscripts(null);
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('voice transcripts', () => {
  it('records a whole session between connect and disconnect', async () => {
    const dir = configure();
    transcriptClientConnected('phone');
    recordUserTurn('fix the login redirect', 'phone');
    recordAgentSpeech('Looking at the auth middleware now.');
    recordNarration('Two files changed.');
    recordUserTurn('and add a test\nfor it', 'stream');
    const path = currentTranscriptPath();
    assert.ok(path);
    transcriptClientDisconnected('phone');
    await sleep(80);
    assert.equal(currentTranscriptPath(), null);

    const text = readFileSync(path, 'utf-8');
    assert.match(text, /^# AgentVoice voice transcript\n# opened .* — session start\n# agent=Stub · workflow=agent_native · input=stream\n/);
    assert.match(text, /\[\d\d:\d\d:\d\d\] EVENT: phone connected\n/);
    assert.match(text, /\] USER \(phone\): fix the login redirect\n/);
    assert.match(text, /\] AGENT: Looking at the auth middleware now\.\n/);
    assert.match(text, /\] NARRATOR: Two files changed\.\n/);
    assert.match(text, /\] USER \(stream\): and add a test\n    for it\n/);
    assert.match(text, /# session ended .* \(all voice clients disconnected\)\n$/);
    assert.equal(readdirSync(dir).length, 1);
  });

  it('keeps one file across a quick reconnect', async () => {
    const dir = configure(60);
    transcriptClientConnected('phone');
    recordUserTurn('first', 'phone');
    transcriptClientDisconnected('phone');
    await sleep(10);
    transcriptClientConnected('phone');
    recordUserTurn('second', 'phone');
    transcriptClientDisconnected('phone');
    await sleep(120);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const text = readFileSync(join(dir, files[0]!), 'utf-8');
    assert.match(text, /phone reconnected/);
    assert.match(text, /USER \(phone\): first[\s\S]*USER \(phone\): second/);
  });

  it('stays open while any client remains', async () => {
    configure(20);
    transcriptClientConnected('phone');
    transcriptClientConnected('audio pipe');
    transcriptClientDisconnected('phone');
    await sleep(50);
    assert.ok(currentTranscriptPath());
    recordAgentSpeech('still here');
    transcriptClientDisconnected('audio pipe');
    await sleep(50);
    assert.equal(currentTranscriptPath(), null);
  });

  it('records nothing when disabled', () => {
    configureTranscripts({ enabled: false, dir: '/nonexistent', keepPlain: 1, maxFileMb: 0, retentionDays: 0 });
    transcriptClientConnected('phone');
    recordUserTurn('ignored');
    assert.equal(currentTranscriptPath(), null);
    transcriptClientDisconnected('phone');
  });
});
