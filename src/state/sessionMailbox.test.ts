/**
 * Per-session mailbox (docs/37 §2, #57).
 *
 * The behaviour that matters: a message is handed over exactly once (twice
 * reads as the user repeating themselves), the queue is bounded, and a
 * finished session's mailbox does not leak into whatever reuses its id.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  postMessage,
  collectMessages,
  peekMessages,
  pendingCount,
  clearMailbox,
  sessionsWithMail,
  resetMailboxes,
} from './sessionMailbox.js';

beforeEach(resetMailboxes);

describe('sessionMailbox', () => {
  test('an empty mailbox collects nothing', () => {
    assert.deepEqual(collectMessages('job-1'), []);
    assert.equal(pendingCount('job-1'), 0);
  });

  test('a queued message is counted before it is collected', () => {
    postMessage('job-1', 'also update the README');
    assert.equal(pendingCount('job-1'), 1);
    assert.equal(peekMessages('job-1')[0]?.text, 'also update the README');
  });

  test('peeking does not consume', () => {
    postMessage('job-1', 'hello');
    peekMessages('job-1');
    peekMessages('job-1');
    assert.equal(pendingCount('job-1'), 1);
  });

  test('collecting hands each message over exactly once', () => {
    postMessage('job-1', 'first');
    postMessage('job-1', 'second');
    const collected = collectMessages('job-1');
    assert.deepEqual(collected.map((m) => m.text), ['first', 'second']);
    assert.deepEqual(collectMessages('job-1'), [], 'a second collect returns nothing');
    assert.equal(pendingCount('job-1'), 0);
  });

  test('messages queued after a collect are delivered on the next one', () => {
    postMessage('job-1', 'first');
    collectMessages('job-1');
    postMessage('job-1', 'second');
    assert.deepEqual(collectMessages('job-1').map((m) => m.text), ['second']);
  });

  test('mailboxes are per session', () => {
    postMessage('job-1', 'for one');
    postMessage('job-2', 'for two');
    assert.deepEqual(collectMessages('job-1').map((m) => m.text), ['for one']);
    assert.equal(pendingCount('job-2'), 1);
  });

  test('the queue is bounded so an unread session cannot grow forever', () => {
    for (let i = 0; i < 30; i++) postMessage('job-1', `message ${i}`);
    const collected = collectMessages('job-1');
    assert.equal(collected.length, 20);
    // The oldest are dropped, not the newest — recent instructions win.
    assert.equal(collected[collected.length - 1]?.text, 'message 29');
  });

  test('clearing drops everything for that session', () => {
    postMessage('job-1', 'hello');
    clearMailbox('job-1');
    assert.equal(pendingCount('job-1'), 0);
    assert.deepEqual(collectMessages('job-1'), []);
  });

  test('sessionsWithMail lists only sessions with undelivered messages', () => {
    postMessage('job-1', 'a');
    postMessage('job-2', 'b');
    collectMessages('job-2');
    assert.deepEqual(sessionsWithMail(), ['job-1']);
  });

  test('the source is recorded so the agent knows where it came from', () => {
    postMessage('job-1', 'from the IDE', 'desk');
    assert.equal(collectMessages('job-1')[0]?.source, 'desk');
  });
});
