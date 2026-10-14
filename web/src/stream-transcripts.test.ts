import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { StreamTranscriptTracker, type StreamSegmentInfo } from './stream-transcripts.js';

function track() {
  const shown: [string, StreamSegmentInfo][] = [];
  const undelivered: [string, number][] = [];
  const tracker = new StreamTranscriptTracker({
    onSegment: (text, info) => shown.push([text, info]),
    onUndelivered: (message, index) => undelivered.push([message, index]),
  });
  return { tracker, shown, undelivered };
}

describe('StreamTranscriptTracker', () => {
  it('shows the words on the transcript frame, not again on the segment frame', () => {
    const { tracker, shown, undelivered } = track();
    tracker.handle({ type: 'transcript', index: 1, text: 'open the readme', audio_ms: 1200, latency_ms: 240 });
    assert.deepEqual(shown, [['open the readme', { index: 1, audioMs: 1200, latencyMs: 240 }]]);
    tracker.handle({ type: 'segment', index: 1, text: 'open the readme', delivered: true, delivery: 'spawn' });
    assert.equal(shown.length, 1);
    assert.equal(undelivered.length, 0);
  });

  it('shows the words on the segment frame from a bridge that sends no transcript frame', () => {
    const { tracker, shown } = track();
    tracker.handle({ type: 'segment', index: 1, text: 'one', delivered: true });
    tracker.handle({ type: 'segment', index: 2, text: 'two', delivered: true });
    assert.deepEqual(
      shown.map(([t]) => t),
      ['one', 'two'],
    );
  });

  it('reports a segment the agent never got, after the words are already up', () => {
    const { tracker, shown, undelivered } = track();
    tracker.handle({ type: 'transcript', index: 4, text: 'hello' });
    tracker.handle({ type: 'segment', index: 4, text: 'hello', delivered: false, reason: 'NO_PROJECT', message: 'No project is selected.' });
    assert.equal(shown.length, 1);
    assert.deepEqual(undelivered, [['No project is selected.', 4]]);
  });

  it('ignores other frames and empty text', () => {
    const { tracker, shown } = track();
    assert.equal(tracker.handle({ type: 'speak', text: 'hi' }), false);
    assert.equal(tracker.handle({ type: 'transcript', index: 1, text: '' }), true);
    assert.equal(shown.length, 0);
  });
});
