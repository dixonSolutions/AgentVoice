import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LivePcmQueue } from '../intelligence/audio/transcribe.js';
import type { LiveTranscription } from '../providers/speech/input/types.js';
import { Utterance, UtteranceTooLargeError, type UtteranceDeps } from './sttUpload.js';

function fakeLive(result: { text: string; model: string } | Error) {
  const pushed: Buffer[] = [];
  let aborted = false;
  let finished = false;
  const session: LiveTranscription = {
    push: (pcm) => pushed.push(pcm),
    finish: async () => {
      finished = true;
      if (result instanceof Error) throw result;
      return result;
    },
    abort: () => {
      aborted = true;
    },
  };
  return {
    session,
    pushed,
    get aborted() {
      return aborted;
    },
    get finished() {
      return finished;
    },
  };
}

function deps(over: Partial<UtteranceDeps> = {}) {
  const transcribed: Buffer[] = [];
  const failures: string[] = [];
  const d: UtteranceDeps = {
    openLive: () => null,
    transcribe: async (pcm) => {
      transcribed.push(pcm);
      return { text: ' whole utterance ', provider: 'groq', model: 'whisper' };
    },
    onLiveFailed: (err, provider) => failures.push(`${provider}: ${err.message}`),
    ...over,
  };
  return { d, transcribed, failures };
}

describe('Utterance', () => {
  it('feeds a live engine each chunk as it is pushed, and asks it for the result at the end', async () => {
    const live = fakeLive({ text: 'fix the build', model: 'sfm' });
    const { d, transcribed } = deps({ openLive: () => ({ provider: 'amazon_transcribe', session: live.session }) });
    const u = new Utterance(d);
    u.push(Buffer.from([1, 2]));
    assert.equal(live.pushed.length, 1, 'the engine has the first chunk before the utterance ends');
    u.push(Buffer.from([3, 4]));
    const t = await u.end();
    assert.deepEqual(live.pushed, [Buffer.from([1, 2]), Buffer.from([3, 4])]);
    assert.deepEqual(
      { text: t.text, provider: t.provider, model: t.model, live: t.live, bytes: t.bytes },
      { text: 'fix the build', provider: 'amazon_transcribe', model: 'sfm', live: true, bytes: 4 },
    );
    assert.equal(transcribed.length, 0, 'the chain is not called when the live session answers');
  });

  it('transcribes the whole utterance through the chain when the live session fails', async () => {
    const live = fakeLive(new Error('stream reset'));
    const { d, transcribed, failures } = deps({ openLive: () => ({ provider: 'amazon_transcribe', session: live.session }) });
    const u = new Utterance(d);
    u.push(Buffer.from([1, 2]));
    u.push(Buffer.from([3, 4]));
    const t = await u.end();
    assert.deepEqual(transcribed, [Buffer.from([1, 2, 3, 4])], 'nothing said is lost');
    assert.equal(t.text, 'whole utterance');
    assert.equal(t.provider, 'groq');
    assert.equal(t.live, false);
    assert.deepEqual(failures, ['amazon_transcribe: stream reset']);
  });

  it('sends a whole-utterance engine everything the moment the utterance ends', async () => {
    const { d, transcribed } = deps();
    const u = new Utterance(d);
    assert.equal(u.isLive, false);
    u.push(Buffer.from([1, 2]));
    u.push(Buffer.from([3, 4]));
    assert.equal(transcribed.length, 0);
    const t = await u.end();
    assert.deepEqual(transcribed, [Buffer.from([1, 2, 3, 4])]);
    assert.equal(t.live, false);
  });

  it('cancel stops the live session and the chain, even mid-transcription', async () => {
    const live = fakeLive({ text: 'x', model: 'm' });
    const u1 = new Utterance(deps({ openLive: () => ({ provider: 'amazon_transcribe', session: live.session }) }).d);
    u1.push(Buffer.from([1, 2]));
    u1.cancel();
    assert.equal(live.aborted, true);

    let seen: AbortSignal | null = null;
    const u2 = new Utterance(
      deps({
        transcribe: (_pcm, signal) => {
          seen = signal;
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        },
      }).d,
    );
    u2.push(Buffer.from([1, 2]));
    const ending = u2.end();
    u2.cancel();
    await assert.rejects(ending, /aborted/);
    assert.equal((seen as AbortSignal | null)?.aborted, true);
    assert.equal(u2.isCancelled, true);
  });

  it('refuses audio past the upload limit', () => {
    const u = new Utterance(deps({ maxBytes: 4 }).d);
    u.push(Buffer.from([1, 2, 3]));
    assert.throws(() => u.push(Buffer.from([4, 5])), UtteranceTooLargeError);
  });
});

describe('LivePcmQueue (Amazon live input)', () => {
  it('releases each chunk to Transcribe as soon as it is pushed, in 200 ms pieces', async () => {
    const q = new LivePcmQueue();
    const it = q[Symbol.asyncIterator]();
    const first = it.next();
    q.push(Buffer.alloc(6400 + 100, 1));
    assert.equal((await first).value?.AudioEvent.AudioChunk.length, 6400);
    assert.equal((await it.next()).value?.AudioEvent.AudioChunk.length, 100);
    const pending = it.next();
    q.push(Buffer.alloc(10, 2));
    assert.equal((await pending).value?.AudioEvent.AudioChunk.length, 10);
    const last = it.next();
    q.end();
    assert.equal((await last).done, true);
  });
});
