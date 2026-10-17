import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { link } from './home.js';
import { detectInstallMode } from '../serve/installMode.js';

test('link() re-points a live link into another install at this one', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sq-link-'));
  try {
    const other = join(scratch, 'old-install');
    mkdirSync(other);
    writeFileSync(join(other, 'package.json'), '{"name":"@ratitisrad/agentvoice","version":"0.1.6"}');
    const home = join(scratch, 'home');
    mkdirSync(home);
    symlinkSync(join(other, 'package.json'), join(home, 'package.json'));
    link(home, 'package.json');
    assert.equal(realpathSync(readlinkSync(join(home, 'package.json'))), realpathSync(join(detectInstallMode().root, 'package.json')));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
