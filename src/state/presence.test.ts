/**
 * Presence state machine (docs/36 §1).
 *
 * The cases that matter here are the ones that used to be indistinguishable:
 * a tunnel blip versus a real departure, and one of two open tabs closing
 * versus the phone actually leaving.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from './presence.js';

/** A tracker whose clock and timers are fully under the test's control. */
function makeTracker(graceMs = 45_000) {
  let now = 1_000_000;
  const timers: Array<{ id: number; fn: () => void; at: number }> = [];
  let nextId = 1;

  const tracker = new PresenceTracker({
    graceMs,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, at: now + ms });
      return id;
    },
    clearTimer: (handle) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  });

  return {
    tracker,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
  };
}

describe('PresenceTracker', () => {
  test('starts away with nobody connected', () => {
    const { tracker } = makeTracker();
    assert.equal(tracker.getState(), 'away');
    assert.equal(tracker.isListening(), false);
  });

  test('a phone client makes the listener connected', () => {
    const { tracker } = makeTracker();
    tracker.register({ kind: 'phone_control' });
    assert.equal(tracker.getState(), 'connected');
    assert.equal(tracker.snapshot().awaySince, null);
  });

  test('a desk client alone is not a listener', () => {
    const { tracker } = makeTracker();
    tracker.register({ kind: 'desk' });
    assert.equal(tracker.getState(), 'away');
    assert.equal(tracker.snapshot().deskPresent, true);
  });

  test('a dropped phone goes to grace, then away once the window expires', () => {
    const { tracker, advance } = makeTracker(45_000);
    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    assert.equal(tracker.getState(), 'grace');
    assert.equal(tracker.isListening(), true, 'grace still counts as listening');

    advance(44_000);
    assert.equal(tracker.getState(), 'grace');

    advance(2_000);
    assert.equal(tracker.getState(), 'away');
    assert.equal(tracker.isListening(), false);
  });

  test('reconnecting inside the grace window never reaches away', () => {
    const { tracker, advance } = makeTracker(45_000);
    const first = tracker.register({ kind: 'phone_control' });
    first.release();
    advance(5_000);
    tracker.register({ kind: 'phone_control' });
    assert.equal(tracker.getState(), 'connected');
    advance(60_000);
    assert.equal(tracker.getState(), 'connected', 'the expired timer must not fire');
  });

  test('closing one of two phone sockets is not a departure', () => {
    const { tracker } = makeTracker();
    const a = tracker.register({ kind: 'phone_control' });
    tracker.register({ kind: 'phone_intelligence' });
    a.release();
    assert.equal(tracker.getState(), 'connected');
  });

  test('an explicit hang-up skips the grace window entirely', () => {
    const { tracker } = makeTracker(45_000);
    const client = tracker.register({ kind: 'phone_control' });
    client.hangUp();
    assert.equal(tracker.getState(), 'hung_up');
    assert.equal(tracker.isListening(), false);
  });

  test('awayMs measures from the moment the phone dropped, not from away', () => {
    const { tracker, advance } = makeTracker(10_000);
    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    advance(30_000);
    assert.equal(tracker.getState(), 'away');
    assert.equal(tracker.snapshot().awayMs, 30_000);
  });

  test('a graceMs of zero makes a drop immediate', () => {
    const { tracker } = makeTracker(0);
    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    assert.equal(tracker.getState(), 'away');
  });

  test('subscribers see every transition with its previous state', () => {
    const { tracker, advance } = makeTracker(1_000);
    const seen: Array<[string, string]> = [];
    tracker.onChange((snap, previous) => seen.push([previous, snap.state]));

    const client = tracker.register({ kind: 'phone_control' });
    client.release();
    advance(2_000);

    assert.deepEqual(seen, [
      ['away', 'connected'],
      ['connected', 'grace'],
      ['grace', 'away'],
    ]);
  });

  test('two missed pongs close a half-open socket', () => {
    const { tracker } = makeTracker();
    let pings = 0;
    let closedWith: number | null = null;
    tracker.register({
      kind: 'phone_control',
      ping: () => pings++,
      close: (code) => {
        closedWith = code;
      },
    });

    tracker.tick();
    tracker.tick();
    assert.equal(pings, 2);
    assert.equal(closedWith, null, 'two unanswered pings are not yet fatal');

    tracker.tick();
    assert.equal(closedWith, 4002);
  });

  test('a pong resets the missed-beat counter', () => {
    const { tracker } = makeTracker();
    let closed = false;
    const client = tracker.register({
      kind: 'phone_control',
      ping: () => {},
      close: () => {
        closed = true;
      },
    });

    tracker.tick();
    client.alive();
    tracker.tick();
    client.alive();
    tracker.tick();
    assert.equal(closed, false);
  });

  test('releasing twice does not double-count the departure', () => {
    const { tracker } = makeTracker(1_000);
    const a = tracker.register({ kind: 'phone_control' });
    const b = tracker.register({ kind: 'phone_control' });
    a.release();
    a.release();
    assert.equal(tracker.getState(), 'connected', 'b still holds the phone');
    b.release();
    assert.equal(tracker.getState(), 'grace');
  });
});
