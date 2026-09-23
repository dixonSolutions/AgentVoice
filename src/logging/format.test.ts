import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatLogLine, formatTimestamp } from './format.js';

const T = new Date(2026, 8, 23, 14, 5, 12, 345).getTime();

describe('formatLogLine', () => {
  it('renders level, module, message and fields on one line', () => {
    const line = JSON.stringify({ level: 30, time: T, pid: 1, hostname: 'h', module: 'server', msg: 'listening', port: 8787, host: '0.0.0.0' });
    assert.equal(formatLogLine(line), '2026-09-23 14:05:12.345 INFO  [server] listening port=8787 host=0.0.0.0');
  });

  it('quotes values that would be ambiguous and JSON-encodes objects', () => {
    const line = JSON.stringify({ level: 40, time: T, msg: 'x', text: 'two words', empty: '', obj: { a: 1 }, list: [1, 2] });
    assert.equal(
      formatLogLine(line),
      '2026-09-23 14:05:12.345 WARN  x text="two words" empty="" obj={"a":1} list=[1,2]',
    );
  });

  it('keeps an error stack, indented under the line', () => {
    const line = JSON.stringify({
      level: 50,
      time: T,
      msg: 'boom',
      err: { type: 'TypeError', message: 'bad', stack: 'TypeError: bad\n    at f (a.ts:1:1)' },
    });
    assert.equal(
      formatLogLine(line),
      '2026-09-23 14:05:12.345 ERROR boom err="TypeError: bad"\n    TypeError: bad\n        at f (a.ts:1:1)',
    );
  });

  it('adds ANSI color only when asked', () => {
    const line = JSON.stringify({ level: 30, time: T, msg: 'hi' });
    assert.doesNotMatch(formatLogLine(line), /\x1b\[/);
    assert.match(formatLogLine(line, { color: true }), /\x1b\[32mINFO/);
  });

  it('passes non-JSON text through untouched', () => {
    assert.equal(formatLogLine('plain console line\n'), 'plain console line');
    assert.equal(formatLogLine('{not json'), '{not json');
  });

  it('formats UTC on request', () => {
    const utc = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
    assert.equal(formatTimestamp(utc, true), '2026-01-02 03:04:05.006');
  });
});
