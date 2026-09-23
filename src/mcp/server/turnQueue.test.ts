import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { voiceTurnQueue } from './turnQueue.js';

afterEach(() => voiceTurnQueue.clear());

describe('voiceTurnQueue', () => {
  it('defaults the source to phone', async () => {
    voiceTurnQueue.enqueue('hello');
    const turn = await voiceTurnQueue.dequeue(10);
    assert.equal(turn?.source, 'phone');
    assert.equal(turn?.segments, undefined);
  });

  it('hands a waiting poll a streamed segment immediately', async () => {
    const pending = voiceTurnQueue.dequeue(1000);
    const delivery = voiceTurnQueue.enqueue('first bit', { source: 'stream' });
    assert.equal(delivery.kind, 'waiter');
    const turn = await pending;
    assert.equal(turn?.text, 'first bit');
    assert.equal(turn?.source, 'stream');
    assert.equal(turn?.segments, 1);
  });

  it('merges consecutive streamed segments into one turn', async () => {
    voiceTurnQueue.enqueue('open the', { source: 'stream' });
    voiceTurnQueue.enqueue('config file', { source: 'stream' });
    voiceTurnQueue.enqueue('and stop', { source: 'stream' });
    const turn = await voiceTurnQueue.dequeue(10);
    assert.equal(turn?.text, 'open the config file and stop');
    assert.equal(turn?.segments, 3);
    assert.equal(voiceTurnQueue.size, 0);
  });

  it('never merges across a turn from another source', async () => {
    voiceTurnQueue.enqueue('streamed one', { source: 'stream' });
    voiceTurnQueue.enqueue('typed', { source: 'desk' });
    voiceTurnQueue.enqueue('streamed two', { source: 'stream' });
    assert.equal((await voiceTurnQueue.dequeue(10))?.text, 'streamed one');
    assert.equal((await voiceTurnQueue.dequeue(10))?.source, 'desk');
    assert.equal((await voiceTurnQueue.dequeue(10))?.text, 'streamed two');
  });

  it('keeps an interrupt flag raised by any merged segment', async () => {
    voiceTurnQueue.enqueue('wait', { source: 'stream' });
    voiceTurnQueue.enqueue('stop that', { source: 'stream' });
    const turn = await voiceTurnQueue.dequeue(10);
    assert.equal(turn?.isInterrupt, true);
  });
});
