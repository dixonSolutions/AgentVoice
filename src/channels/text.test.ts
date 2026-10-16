import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cleanCommandText, splitCommand } from './text.js';

const TAGS = [/<@!?111>/g, /<@&222>/g];

describe('cleanCommandText', () => {
  it('takes out the tag and whatever separated it from the command', () => {
    for (const raw of [
      '<@111> sessions',
      '<@111>sessions',
      '<@111>\nsessions',
      '<@111>\n\n  sessions  ',
      '<@!111> sessions',
      '<@&222> sessions', // Discord inserted the bot's role instead of the user
      '<@111>: sessions',
      '<@111>, sessions',
      '<@111> — sessions',
      '​<@111>​ sessions﻿',
      'hey <@111> sessions',
    ]) {
      const cleaned = cleanCommandText(raw, TAGS);
      assert.equal(splitCommand(cleaned).cmd, raw.startsWith('hey') ? 'hey' : 'sessions', JSON.stringify(raw));
    }
  });

  it('keeps the arguments, splitting on any whitespace including line breaks', () => {
    assert.deepEqual(splitCommand(cleanCommandText('<@111>\nvoice\ndefault   2', TAGS)), {
      cmd: 'voice',
      args: ['default', '2'],
      rest: 'voice\ndefault   2'.replace(/^voice\s*/, ''),
    });
    assert.equal(splitCommand('/STATUS').cmd, 'status');
    assert.deepEqual(splitCommand(''), { cmd: '', args: [], rest: '' });
  });
});
