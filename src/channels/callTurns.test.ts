import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ARMED_MS, CallTurns, howToTalk, type CallTurnSettings } from './callTurns.js';
import { cuePcm } from './cues.js';

const WAKE = { start: 'hey squeaker', end: 'send', cancel: 'cancel' };
const settings = (over: Partial<CallTurnSettings> = {}): CallTurnSettings => ({
  inputMode: 'turns',
  wakeWordsEnabled: true,
  wakeWords: WAKE,
  turnSubmit: { silenceMs: 700, vadEnabled: true },
  ...over,
});
const never = () => assert.fail('no timed submit expected');

describe('CallTurns — the phone voice session rules on a call', () => {
  it('stream input: every segment is a request, wake words or not', () => {
    const t = new CallTurns(settings({ inputMode: 'stream' }), never);
    assert.deepEqual(t.feed('did you see the game'), { action: 'deliver', text: 'did you see the game' });
    assert.equal(t.wakeWords, false);
  });

  it('wake words + VAD: the start phrase opens a request the pause ends; room talk is ignored', () => {
    const t = new CallTurns(settings(), never);
    assert.deepEqual(t.feed('did you see the game last night'), { action: 'ignore' });
    assert.deepEqual(t.feed('Hey squeaker, run the tests.'), { action: 'deliver', text: 'run the tests' });
    assert.deepEqual(t.feed('and the other thing'), { action: 'ignore' }, 'each request needs the phrase again');
  });

  it('the phrase alone opens the capture for what is said next, until it lapses', () => {
    let now = 0;
    const t = new CallTurns(settings(), never, () => now);
    assert.deepEqual(t.feed('hey squeaker'), { action: 'armed' });
    now += 2000;
    assert.deepEqual(t.feed('fix the login redirect'), { action: 'deliver', text: 'fix the login redirect' });
    assert.deepEqual(t.feed('hey squeaker'), { action: 'armed' });
    now += ARMED_MS + 1;
    assert.deepEqual(t.feed('never mind'), { action: 'ignore' });
  });

  it('cancel drops an open capture', () => {
    const t = new CallTurns(settings(), never);
    assert.deepEqual(t.feed('hey squeaker'), { action: 'armed' });
    assert.deepEqual(t.feed('cancel'), { action: 'cancel' });
    assert.deepEqual(t.feed('run it anyway'), { action: 'ignore' });
  });

  it('VAD off: segments are held until the end phrase', () => {
    const t = new CallTurns(settings({ turnSubmit: { silenceMs: 700, vadEnabled: false } }), never);
    assert.deepEqual(t.feed('hey squeaker open the readme'), { action: 'buffered', text: 'open the readme' });
    assert.deepEqual(t.feed('and the changelog'), { action: 'buffered', text: 'open the readme and the changelog' });
    assert.deepEqual(t.feed('send'), { action: 'deliver', text: 'open the readme and the changelog' });
  });

  it('wake words off: every utterance is a request; with VAD off the silence timer ends it', async () => {
    assert.deepEqual(new CallTurns(settings({ wakeWordsEnabled: false }), never).feed('run the tests'), { action: 'deliver', text: 'run the tests' });
    const sent: string[] = [];
    const t = new CallTurns(settings({ wakeWordsEnabled: false, turnSubmit: { silenceMs: 30, vadEnabled: false } }), (x) => sent.push(x));
    assert.deepEqual(t.feed('open the readme'), { action: 'buffered', text: 'open the readme' });
    t.feed('then summarise it');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sent, ['open the readme then summarise it']);
  });

  it('says how to talk to it, from the same settings', () => {
    assert.equal(howToTalk(settings()), 'Say hey squeaker before each request.');
    assert.equal(howToTalk(settings({ turnSubmit: { silenceMs: 700, vadEnabled: false } })), 'Say hey squeaker before each request, and send when you are done.');
    assert.equal(howToTalk(settings({ wakeWordsEnabled: false })), '');
    assert.equal(howToTalk(settings({ inputMode: 'stream' })), '');
  });
});

describe('call cues', () => {
  it('every cue has audio', () => {
    for (const cue of ['listening', 'sent', 'cancel', 'error'] as const) assert.ok(cuePcm(cue).length > 1000, cue);
  });
});
