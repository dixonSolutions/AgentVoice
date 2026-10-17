import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { chunkText, toSlackMrkdwn, toTelegramHtml, toWhatsApp } from '../format.js';
import type { ChannelHub } from '../hub.js';
import { TelegramAdapter } from './telegram.js';
import { verifyMetaSignature } from './whatsapp.js';

describe('formatting', () => {
  const text = 'Use **sessions** then `use 2` — _quietly_ <ok> & done';
  it('renders the shared markup per platform', () => {
    assert.equal(toTelegramHtml(text), 'Use <b>sessions</b> then <code>use 2</code> — <i>quietly</i> &lt;ok&gt; &amp; done');
    assert.equal(toSlackMrkdwn(text), 'Use *sessions* then `use 2` — _quietly_ &lt;ok&gt; &amp; done');
    assert.equal(toWhatsApp(text), 'Use *sessions* then ```use 2``` — _quietly_ <ok> & done');
    assert.equal(toTelegramHtml('snake_case_name stays'), 'snake_case_name stays');
  });

  it('splits long replies at line breaks', () => {
    const chunks = chunkText(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n'), 70);
    assert.deepEqual(chunks.map((c) => c.length), [61, 30]);
    assert.ok(chunkText('x'.repeat(150), 70).every((c) => c.length <= 70));
  });
});

describe('Telegram command parsing', () => {
  const tg = new TelegramAdapter({} as ChannelHub, 'token');
  (tg as unknown as { username: string }).username = 'SqueakyBot';
  it('turns /commands into the command line and ignores other bots’ commands', () => {
    assert.deepEqual(tg.normalize('/status', []), { text: 'status', mentioned: true });
    assert.deepEqual(tg.normalize('/use@SqueakyBot 2', []), { text: 'use 2', mentioned: true });
    assert.deepEqual(tg.normalize('/use@OtherBot 2', []), { text: '', mentioned: false });
  });
  it('strips a mention of this bot', () => {
    const text = '@SqueakyBot sessions site';
    assert.deepEqual(tg.normalize(text, [{ type: 'mention', offset: 0, length: 11 }]), { text: 'sessions site', mentioned: true });
    assert.deepEqual(tg.normalize('@someone hi', [{ type: 'mention', offset: 0, length: 8 }]), { text: '@someone hi', mentioned: false });
  });
});

describe('WhatsApp webhook signature', () => {
  it('accepts Meta’s HMAC and rejects anything else', () => {
    const raw = Buffer.from('{"entry":[]}');
    const sig = `sha256=${createHmac('sha256', 'secret').update(raw).digest('hex')}`;
    assert.equal(verifyMetaSignature(raw, sig, 'secret'), true);
    assert.equal(verifyMetaSignature(raw, sig, 'other'), false);
    assert.equal(verifyMetaSignature(Buffer.from('{"entry":[1]}'), sig, 'secret'), false);
    assert.equal(verifyMetaSignature(raw, undefined, 'secret'), false);
    assert.equal(verifyMetaSignature(raw, 'sha256=00', 'secret'), false);
  });
});
