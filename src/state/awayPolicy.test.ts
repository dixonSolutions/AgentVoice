/**
 * Away policy (docs/36 §3–4).
 *
 * The decisions worth pinning: grace still counts as listening, a conversation
 * override beats the saved setting without changing it, an approval card is
 * never silently allowed while nobody is watching, and askpass fails fast
 * instead of hanging a shell on a password no one will type.
 *
 * Config and presence are injected through `useAwayPolicyDeps`, so none of
 * this needs a config file on disk or a live WebSocket.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PresenceTracker } from './presence.js';
import type { SessionSettings } from '../config.js';
import {
  approvalPolicy,
  askpassPolicy,
  awayBudgetSnapshot,
  beginAwayPeriod,
  chargeAwayBudget,
  effectiveAwayPolicy,
  endAwayPeriod,
  getConversationAwayPolicy,
  isListening,
  listenerBlock,
  resetAwayPolicyForTests,
  setConversationAwayPolicy,
  useAwayPolicyDeps,
  withListener,
} from './awayPolicy.js';

const session: SessionSettings = {
  graceMs: 45_000,
  onPhoneAway: 'keep_working',
  onBridgeRestart: 'keep_alive',
  unattended: {
    maxRuntimeMs: 3_600_000,
    maxToolCalls: 0,
    approvals: 'wait_push',
    approvalTimeoutMs: 900_000,
    secrets: 'fail_fast',
    requireWorktree: false,
    notifyOnFinish: true,
  },
};

let tracker: PresenceTracker;

function resetPresence(graceMs = 45_000): void {
  tracker = new PresenceTracker({ graceMs });
  useAwayPolicyDeps({ sessionSettings: () => session, presence: () => tracker });
}

beforeEach(() => {
  resetAwayPolicyForTests();
  session.onPhoneAway = 'keep_working';
  session.unattended.approvals = 'wait_push';
  session.unattended.secrets = 'fail_fast';
  session.unattended.maxToolCalls = 0;
  session.unattended.maxRuntimeMs = 3_600_000;
  resetPresence();
});

describe('effective policy', () => {
  test('falls back to the saved setting with no override', () => {
    session.onPhoneAway = 'finish_turn';
    assert.equal(effectiveAwayPolicy(), 'finish_turn');
  });

  test('a conversation override wins without changing the saved setting', () => {
    session.onPhoneAway = 'stop_all';
    setConversationAwayPolicy('keep_working');
    assert.equal(effectiveAwayPolicy(), 'keep_working');
    assert.equal(session.onPhoneAway, 'stop_all', 'the saved setting is untouched');
  });

  test('clearing the override goes back to the saved setting', () => {
    setConversationAwayPolicy('stop_all');
    assert.equal(getConversationAwayPolicy(), 'stop_all');
    setConversationAwayPolicy(null);
    assert.equal(getConversationAwayPolicy(), null);
    assert.equal(effectiveAwayPolicy(), 'keep_working');
  });
});

describe('the listener block', () => {
  test('tells a connected agent to speak and finish the turn', () => {
    tracker.register({ kind: 'phone_control' });
    const block = listenerBlock();
    assert.equal(block.state, 'connected');
    assert.equal(block.away_since, null);
    assert.match(block.instructions, /listening/);
  });

  test('treats grace as a blip, not a departure', () => {
    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    const block = listenerBlock();
    assert.equal(block.state, 'grace');
    assert.match(block.instructions, /blip|as if they were listening/);
    assert.equal(isListening(), true);
  });

  test('carries the policy instructions once away', () => {
    resetPresence(0);
    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    session.onPhoneAway = 'stop_all';
    const block = listenerBlock();
    assert.equal(block.state, 'away');
    assert.match(block.instructions, /safe point/);
  });

  test('withListener attaches the block to any tool result', () => {
    tracker.register({ kind: 'phone_control' });
    const result = withListener({ ok: true });
    assert.equal(result.ok, true);
    assert.equal(result.listener.state, 'connected');
  });

  test('reports a watching desk client separately from the phone', () => {
    tracker.register({ kind: 'desk' });
    const block = listenerBlock();
    assert.equal(block.desk_watching, true);
    assert.equal(block.state, 'away', 'a desk client is not a listener');
  });
});

describe('approval policy', () => {
  test('asks normally while the user is listening', () => {
    tracker.register({ kind: 'phone_control' });
    const decision = approvalPolicy(120_000);
    assert.equal(decision.action, 'ask');
    assert.equal(decision.timeoutMs, 120_000);
  });

  test('wait_push keeps the card open far longer while away', () => {
    const decision = approvalPolicy(120_000);
    assert.equal(decision.action, 'ask');
    assert.equal(decision.timeoutMs, 900_000);
  });

  test('deny answers no rather than stalling the run', () => {
    session.unattended.approvals = 'deny';
    const decision = approvalPolicy(120_000);
    assert.equal(decision.action, 'deny');
    assert.match(decision.message ?? '', /another approach/);
  });

  test('skip declines the step but keeps the agent working', () => {
    session.unattended.approvals = 'skip';
    const decision = approvalPolicy(120_000);
    assert.equal(decision.action, 'skip');
    assert.match(decision.message ?? '', /carry on/);
  });

  test('no away mode ever allows an approval on the user behalf', () => {
    for (const mode of ['wait_push', 'deny', 'skip'] as const) {
      session.unattended.approvals = mode;
      const decision = approvalPolicy(1_000);
      assert.notEqual(decision.action, 'allow' as unknown as typeof decision.action);
    }
  });
});

describe('askpass policy', () => {
  test('asks while the user is listening', () => {
    tracker.register({ kind: 'phone_control' });
    assert.equal(askpassPolicy().ask, true);
  });

  test('fails fast while away by default, rather than hanging the shell', () => {
    const decision = askpassPolicy();
    assert.equal(decision.ask, false);
    assert.match(decision.reason ?? '', /fail fast/);
  });

  test('wait_push keeps the prompt open for the away timeout', () => {
    session.unattended.secrets = 'wait_push';
    const decision = askpassPolicy();
    assert.equal(decision.ask, true);
    assert.equal(decision.timeoutMs, 900_000);
  });
});

describe('unattended budget', () => {
  test('does not apply until an away period starts', () => {
    assert.equal(chargeAwayBudget().exceeded, false);
    assert.equal(awayBudgetSnapshot().active, false);
  });

  test('counts tool calls once the user is away', () => {
    beginAwayPeriod();
    chargeAwayBudget();
    chargeAwayBudget();
    assert.equal(awayBudgetSnapshot().toolCalls, 2);
  });

  test('trips on the tool-call cap', () => {
    session.unattended.maxToolCalls = 2;
    beginAwayPeriod();
    assert.equal(chargeAwayBudget().exceeded, false);
    assert.equal(chargeAwayBudget().exceeded, false);
    const verdict = chargeAwayBudget();
    assert.equal(verdict.exceeded, true);
    assert.equal(verdict.reason, 'tool_calls');
  });

  test('a cap of zero means no tool-call limit', () => {
    session.unattended.maxToolCalls = 0;
    beginAwayPeriod();
    for (let i = 0; i < 50; i++) assert.equal(chargeAwayBudget().exceeded, false);
  });

  test('trips on wall-clock runtime', () => {
    const start = 1_000_000;
    session.unattended.maxRuntimeMs = 60_000;
    beginAwayPeriod(start);
    assert.equal(chargeAwayBudget(start + 30_000).exceeded, false);
    const verdict = chargeAwayBudget(start + 61_000);
    assert.equal(verdict.exceeded, true);
    assert.equal(verdict.reason, 'runtime');
  });

  test('coming back clears the budget', () => {
    session.unattended.maxToolCalls = 1;
    beginAwayPeriod();
    chargeAwayBudget();
    assert.equal(chargeAwayBudget().exceeded, true);
    endAwayPeriod();
    assert.equal(chargeAwayBudget().exceeded, false);
  });
});
