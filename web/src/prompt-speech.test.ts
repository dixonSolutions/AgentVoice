/**
 * Reading prompt cards aloud (docs/40 §1, #63).
 *
 * Speaking happens on the phone, from the card itself, so these rules live in
 * the PWA. The ones worth pinning down: a secret prompt is never read out at
 * any level, `off` really means silent, and `announce` never leaks the content
 * it is announcing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  promptSpeechLines,
  markPromptSpoken,
  hasSpokenPrompt,
  forgetSpokenPrompts,
} from './prompt-speech.js';

const question = {
  kind: 'user_input' as const,
  request_id: 'q1',
  question: 'Should I delete the old migrations?',
  input_type: 'yesno' as const,
};

const choice = {
  kind: 'user_input' as const,
  request_id: 'q2',
  question: 'Which database?',
  input_type: 'choice' as const,
  options: ['postgres', 'sqlite', 'mysql'],
};

const plan = {
  kind: 'plan_approval' as const,
  request_id: 'p1',
  title: 'Split the auth module',
  steps: ['Extract the session store', 'Move the guards', 'Update the imports'],
  estimated_impact: 'Touches 12 files.',
};

const secret = {
  kind: 'secret_input' as const,
  request_id: 's1',
  prompt: '[sudo] password for borys on build-01:',
  source: 'sudo' as const,
};

const permission = {
  kind: 'permission' as const,
  request_id: 'perm1',
  provider: 'Claude Code',
  tool_name: 'Bash',
  summary: 'rm -rf node_modules',
  input: null,
};

describe('promptSpeechLines', () => {
  test('off says nothing at all', () => {
    for (const request of [question, plan, secret, permission]) {
      assert.deepEqual(promptSpeechLines(request, 'off'), [], request.kind);
    }
  });

  test('announce says there is something waiting, without the content', () => {
    const lines = promptSpeechLines(question, 'announce');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('migrations'), lines[0]);
  });

  test('question reads the question and offers yes or no', () => {
    const lines = promptSpeechLines(question, 'question');
    assert.equal(lines[0], 'Should I delete the old migrations?');
    assert.equal(lines[1], 'Yes or no?');
  });

  test('a choice is read as a person would say it', () => {
    const lines = promptSpeechLines(choice, 'question');
    assert.equal(lines[1], 'Pick one: postgres, sqlite, or mysql.');
  });

  test('a plan gives the title and step count, not the steps', () => {
    const lines = promptSpeechLines(plan, 'question');
    assert.equal(lines[0], 'Split the auth module — 3 steps.');
    assert.ok(!lines.some((l) => l.includes('Extract the session store')), lines.join(' | '));
    assert.equal(lines[lines.length - 1], 'Approve, reject, or ask for changes?');
  });

  test('full reads every step and the impact', () => {
    const lines = promptSpeechLines(plan, 'full');
    assert.ok(lines.includes('Extract the session store'));
    assert.ok(lines.includes('Move the guards'));
    assert.ok(lines.includes('Touches 12 files.'));
  });

  test('full summarises the tail of a long plan rather than reading forever', () => {
    const long = { ...plan, steps: Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`) };
    const lines = promptSpeechLines(long, 'full');
    assert.ok(lines.includes('Step 8'));
    assert.ok(!lines.includes('Step 9'));
    assert.ok(lines.includes('And 12 more on screen.'));
  });

  test('a secret prompt is never read aloud, at any level', () => {
    for (const mode of ['announce', 'question', 'full'] as const) {
      const lines = promptSpeechLines(secret, mode);
      assert.equal(lines.length, 1, mode);
      assert.ok(!lines[0]!.includes('borys'), lines[0]);
      assert.ok(!lines[0]!.includes('build-01'), lines[0]);
      assert.ok(!lines[0]!.includes('sudo]'), lines[0]);
    }
  });

  test('a permission card names the CLI and what it wants to run', () => {
    const lines = promptSpeechLines(permission, 'question');
    assert.equal(lines[0], 'Claude Code wants to run rm -rf node_modules.');
    assert.match(lines[1]!, /yes or no/i);
  });

  test('announce on a permission card omits the command', () => {
    const lines = promptSpeechLines(permission, 'announce');
    assert.ok(!lines[0]!.includes('rm -rf'), lines[0]);
  });
});

describe('spoken-card bookkeeping', () => {
  test('a card re-sent on reconnect is not read twice', () => {
    forgetSpokenPrompts();
    assert.equal(hasSpokenPrompt('q1'), false);
    markPromptSpoken('q1');
    assert.equal(hasSpokenPrompt('q1'), true);
    // A different card with identical text still gets read.
    assert.equal(hasSpokenPrompt('q2'), false);
  });

  test('a new session forgets what it already read', () => {
    markPromptSpoken('q1');
    forgetSpokenPrompts();
    assert.equal(hasSpokenPrompt('q1'), false);
  });
});
