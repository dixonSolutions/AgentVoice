/**
 * Session directory naming and resolution (docs/37 §3).
 *
 * Handles are UUIDs, so the user never says one out loud — they say "the auth
 * worker" or "the second one". These are the pure parts of that: the rest of
 * the directory reads live processes and CLI stores, which belongs in a live
 * test rather than here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { spokenName } from './sessionDirectory.js';

describe('spokenName', () => {
  test('prefers the worktree name, which the user usually chose', () => {
    assert.equal(spokenName({ worktree: 'auth-refactor', kind: 'worker', index: 0 }), 'auth worker');
  });

  test('falls back to the first content word of the prompt', () => {
    assert.equal(
      spokenName({ prompt: 'Please fix the login redirect', kind: 'worker', index: 0 }),
      'login worker',
    );
  });

  test('skips filler words rather than naming something "please worker"', () => {
    const name = spokenName({ prompt: 'can you please update the docs', kind: 'worker', index: 0 });
    assert.ok(!name.startsWith('can'), name);
    assert.ok(!name.startsWith('please'), name);
    assert.equal(name, 'docs worker');
  });

  test('numbers the session when there is nothing to name it after', () => {
    assert.equal(spokenName({ kind: 'worker', index: 0 }), 'worker 1');
    assert.equal(spokenName({ kind: 'external', index: 2 }), 'session 3');
  });

  test('uses a noun that matches the kind', () => {
    assert.equal(spokenName({ prompt: 'billing', kind: 'recent', index: 0 }), 'billing thread');
  });
});
