import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderPlist } from './commands/serviceInstall.js';
import { parseLaunchctlPrint, parseScQuery } from './service.js';

test('parseScQuery reads state, pid and start type from sc.exe', () => {
  const queryex = [
    'SERVICE_NAME: AgentVoice',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        STATE              : 4  RUNNING',
    '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
    '        PID                : 4812',
  ].join('\r\n');
  assert.deepEqual(parseScQuery(queryex), { state: 'RUNNING', pid: 4812, startType: null });

  const qc = '        START_TYPE         : 2   AUTO_START\r\n';
  assert.equal(parseScQuery(qc).startType, 'AUTO_START');
  assert.deepEqual(parseScQuery('        STATE              : 1  STOPPED\r\n        PID                : 0'), {
    state: 'STOPPED',
    pid: null,
    startType: null,
  });
});

test('parseLaunchctlPrint reads state and pid', () => {
  const out = 'gui/501/com.agentvoice.bridge = {\n\tactive count = 1\n\tstate = running\n\tpid = 7311\n}';
  assert.deepEqual(parseLaunchctlPrint(out), { state: 'running', pid: 7311 });
  assert.deepEqual(parseLaunchctlPrint('\tstate = not running\n'), { state: 'not running', pid: null });
});

test('renderPlist escapes paths and carries the home and PATH', () => {
  const plist = renderPlist({
    args: ['/usr/local/bin/node', '/Users/a & b/agentvoice.mjs', 'run'],
    home: '/Users/a/.agentvoice',
    path: '/opt/homebrew/bin:/usr/bin',
    log: '/Users/a/.agentvoice/logs/launchd.log',
  });
  assert.match(plist, /<string>\/Users\/a &amp; b\/agentvoice\.mjs<\/string>/);
  assert.match(plist, /<key>AGENTVOICE_HOME<\/key>\s*<string>\/Users\/a\/\.agentvoice<\/string>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.agentvoice\.bridge<\/string>/);
});
