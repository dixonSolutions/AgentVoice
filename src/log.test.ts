import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { childLogger, closeLogger, getSessionLog, initLogger } from './log.js';

// Declared at import time, before initLogger() — exactly like every module in src/.
const early = childLogger('early-module');

const dir = mkdtempSync(join(tmpdir(), 'agentvoice-log-'));
after(() => {
  closeLogger('test end');
  rmSync(dir, { recursive: true, force: true });
});

describe('logger', () => {
  it('routes module loggers declared before initLogger() to the session file', () => {
    early.info({ phase: 'boot' }, 'logged before init');
    early.debug('boot debug');

    initLogger({
      level: 'error', // keep the test output quiet
      files: {
        dir,
        level: 'debug',
        keepPlain: 3,
        maxFileMb: 0,
        retentionDays: 0,
        describe: () => ({ version: 'test', pid: 42 }),
      },
    });

    early.debug({ answer: 42 }, 'after init');
    childLogger('late-module').warn('late warning');
    early.trace('below the file level');

    const path = getSessionLog()?.path;
    assert.ok(path);
    closeLogger('test shutdown');

    const text = readFileSync(path, 'utf-8');
    assert.match(text, /^# AgentVoice bridge log\n/);
    assert.match(text, /# version=test · pid=42\n/);
    // Replayed from the boot buffer, at or above the file level.
    assert.match(text, /INFO  \[early-module\] logged before init phase=boot\n/);
    assert.match(text, /DEBUG \[early-module\] boot debug\n/);
    // The early proxy follows the new root: its level is now the file's `debug`.
    assert.match(text, /DEBUG \[early-module\] after init answer=42\n/);
    assert.match(text, /WARN  \[late-module\] late warning\n/);
    assert.doesNotMatch(text, /below the file level/);
    assert.match(text, /# session ended .* \(test shutdown\)\n$/);
    assert.equal(readdirSync(dir).length, 1);
  });

  it('child loggers stay usable as pino loggers', () => {
    const child = childLogger('proxy-check').child({ sub: 1 });
    assert.equal(typeof child.info, 'function');
    assert.equal(typeof early.level, 'string');
  });
});
