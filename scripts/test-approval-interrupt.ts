/**
 * Smoke test: voice-turn enqueue aborts blocking approval/input waits and
 * delivers the utterance as tool-result-shaped data (not double-queued).
 *
 * Run: npx tsx scripts/test-approval-interrupt.ts
 */

import assert from 'node:assert/strict';
import {
  cancelAllRequests,
  pendingCount,
  registerRequest,
  resolveRequest,
  type ApprovalResponse,
} from '../src/mcp/server/approvalRegistry.js';
import { voiceTurnQueue } from '../src/mcp/server/turnQueue.js';

let failed = 0;

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, err: unknown): void {
  failed += 1;
  console.error(`  ✗ ${label}`);
  console.error(err);
}

async function reset(): Promise<void> {
  cancelAllRequests('test reset');
  voiceTurnQueue.clear();
  // Let rejected promises settle without unhandledRejection noise.
  await Promise.resolve();
}

async function testInterruptUserInput(): Promise<void> {
  await reset();
  const { request_id, promise } = registerRequest(
    (id) => ({
      kind: 'user_input',
      request_id: id,
      question: 'Add tests?',
      input_type: 'yesno',
    }),
    60_000,
  );

  assert.equal(pendingCount(), 1);

  const delivery = voiceTurnQueue.enqueue('skip tests and just ship it');
  assert.equal(delivery.kind, 'approval_interrupt');
  if (delivery.kind === 'approval_interrupt') {
    assert.equal(delivery.aborted.length, 1);
    assert.equal(delivery.aborted[0]?.request_id, request_id);
  }

  const response = await promise;
  assert.equal(response.kind, 'interrupted_by_voice_turn');
  if (response.kind === 'interrupted_by_voice_turn') {
    assert.equal(response.user_turn, 'skip tests and just ship it');
    assert.equal(response.is_interrupt, false);
  }

  assert.equal(pendingCount(), 0);
  assert.equal(voiceTurnQueue.size, 0, 'turn must not also sit in next_voice_turn queue');
  ok('user_input wait interrupted; turn not double-queued');
}

async function testInterruptPlanApproval(): Promise<void> {
  await reset();
  const { promise } = registerRequest(
    (id) => ({
      kind: 'plan_approval',
      request_id: id,
      title: 'Refactor auth',
      steps: ['Rewrite middleware', 'Update tests'],
    }),
    60_000,
  );

  const delivery = voiceTurnQueue.enqueue('stop', { isInterrupt: true });
  assert.equal(delivery.kind, 'approval_interrupt');

  const response = await promise;
  assert.equal(response.kind, 'interrupted_by_voice_turn');
  if (response.kind === 'interrupted_by_voice_turn') {
    assert.equal(response.user_turn, 'stop');
    assert.equal(response.is_interrupt, true);
  }
  assert.equal(voiceTurnQueue.size, 0);
  ok('plan_approval wait interrupted with is_interrupt');
}

async function testWaiterTakesPriority(): Promise<void> {
  await reset();
  const { request_id, promise: approvalPromise } = registerRequest(
    (id) => ({
      kind: 'user_input',
      request_id: id,
      question: 'Still waiting?',
      input_type: 'freetext',
    }),
    60_000,
  );

  const dequeuePromise = voiceTurnQueue.dequeue(5_000);
  // Yield so the waiter is registered before enqueue.
  await Promise.resolve();
  assert.equal(voiceTurnQueue.waitersCount, 1);

  const delivery = voiceTurnQueue.enqueue('hello from poll');
  assert.equal(delivery.kind, 'waiter');

  const turn = await dequeuePromise;
  assert.ok(turn);
  assert.equal(turn!.text, 'hello from poll');
  assert.equal(pendingCount(), 1, 'approval must remain pending when next_voice_turn waiter exists');

  resolveRequest(request_id, { kind: 'user_input', answer: 'cleanup' });
  await approvalPromise;
  ok('next_voice_turn waiter wins over approval interrupt');
}

async function testQueuesWhenNoWaitersOrApprovals(): Promise<void> {
  await reset();
  const delivery = voiceTurnQueue.enqueue('remember this for later');
  assert.equal(delivery.kind, 'queued');
  assert.equal(voiceTurnQueue.size, 1);

  const turn = await voiceTurnQueue.dequeue(100);
  assert.ok(turn);
  assert.equal(turn!.text, 'remember this for later');
  ok('turn queues when nothing is waiting');
}

async function testNormalResolveStillWorks(): Promise<void> {
  await reset();
  const { request_id, promise } = registerRequest(
    (id) => ({
      kind: 'user_input',
      request_id: id,
      question: 'OK?',
      input_type: 'yesno',
    }),
    60_000,
  );

  const okResolve = resolveRequest(request_id, { kind: 'user_input', answer: 'yes' });
  assert.equal(okResolve, true);
  const response: ApprovalResponse = await promise;
  assert.equal(response.kind, 'user_input');
  if (response.kind === 'user_input') {
    assert.equal(response.answer, 'yes');
  }
  ok('normal approval resolve unchanged');
}

async function main(): Promise<void> {
  console.log('approval interrupt / inject-as-tool-output\n');
  for (const [name, fn] of [
    ['interrupt user_input', testInterruptUserInput],
    ['interrupt plan_approval', testInterruptPlanApproval],
    ['waiter priority', testWaiterTakesPriority],
    ['queue fallback', testQueuesWhenNoWaitersOrApprovals],
    ['normal resolve', testNormalResolveStillWorks],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      fail(name, err);
    }
  }
  await reset();
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll tests passed');
}

void main();
