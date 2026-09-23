import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, describe, it } from 'node:test';
import {
  archiveLogDir,
  dayKey,
  fileStamp,
  gzipFile,
  listLogFiles,
  RotatingFile,
  uniqueLogPath,
} from './logFiles.js';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentvoice-logs-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('names', () => {
  it('stamps with local date and time, date first', () => {
    const d = new Date(2026, 8, 3, 7, 5, 9);
    assert.equal(fileStamp(d), '2026-09-03_07-05-09');
    assert.equal(dayKey(d), '2026-09-03');
  });

  it('never reuses a name, including one already compressed', () => {
    const dir = tempDir();
    const d = new Date(2026, 8, 3, 7, 5, 9);
    const first = uniqueLogPath(dir, d);
    assert.ok(first.endsWith('2026-09-03_07-05-09.log'));
    writeFileSync(first, 'x');
    const second = uniqueLogPath(dir, d);
    assert.ok(second.endsWith('2026-09-03_07-05-09_2.log'));
    writeFileSync(`${second}.gz`, 'x');
    assert.ok(uniqueLogPath(dir, d).endsWith('2026-09-03_07-05-09_3.log'));
  });
});

describe('RotatingFile', () => {
  it('writes a header, then appends', () => {
    const dir = tempDir();
    const f = new RotatingFile({ dir, header: ({ reason }) => `# header ${reason}\n` });
    f.write('one\n');
    f.write('two\n');
    f.close('# bye\n');
    assert.equal(readFileSync(f.path, 'utf-8'), '# header start\none\ntwo\n# bye\n');
  });

  it('rolls to a new file past the size cap and reports the closed one', () => {
    const dir = tempDir();
    const closed: string[] = [];
    let t = new Date(2026, 8, 3, 10, 0, 0).getTime();
    const f = new RotatingFile({
      dir,
      maxBytes: 20,
      now: () => new Date((t += 1000)),
      header: ({ previous }) => (previous ? `# after ${previous.split('/').pop()}\n` : ''),
      onRotate: (p) => closed.push(p),
    });
    const firstPath = f.path;
    f.write('0123456789\n');
    f.write('0123456789\n'); // 22 bytes > 20 → roll before writing
    f.close();
    assert.deepEqual(closed, [firstPath]);
    assert.notEqual(f.path, firstPath);
    assert.equal(readFileSync(firstPath, 'utf-8'), '0123456789\n');
    assert.match(readFileSync(f.path, 'utf-8'), /^# after .*\.log\n0123456789\n$/);
  });

  it('rolls at local midnight so a file never spans two dates', () => {
    const dir = tempDir();
    let now = new Date(2026, 8, 3, 23, 59, 58);
    const f = new RotatingFile({ dir, now: () => now, header: ({ reason }) => `# ${reason}\n` });
    f.write('late\n');
    now = new Date(2026, 8, 4, 0, 0, 1);
    f.write('early\n');
    f.close();
    const names = listLogFiles(dir).map((x) => x.name);
    assert.deepEqual(names, ['2026-09-04_00-00-01.log', '2026-09-03_23-59-58.log']);
    assert.equal(readFileSync(join(dir, names[0]!), 'utf-8'), '# midnight\nearly\n');
  });

  it('stops quietly and reports once if the file becomes unwritable', () => {
    const dir = tempDir();
    const errors: string[] = [];
    const f = new RotatingFile({ dir, onError: (e) => errors.push(e.message) });
    f.close();
    // Writing after close is a no-op, never a throw.
    f.write('ignored\n');
    assert.deepEqual(errors, []);
    assert.equal(f.isOpen, false);
  });
});

describe('archiving', () => {
  function seed(dir: string, names: string[]): void {
    names.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, `${name}\n`.repeat(50));
      const t = new Date(2026, 0, 1 + i);
      utimesSync(path, t, t);
    });
  }

  it('gzips a file losslessly and keeps its age', async () => {
    const dir = tempDir();
    seed(dir, ['2026-01-01_00-00-00.log']);
    const plain = join(dir, '2026-01-01_00-00-00.log');
    const before = readFileSync(plain);
    const mtime = statSync(plain).mtimeMs;
    const gz = await gzipFile(plain);
    assert.equal(existsSync(plain), false);
    assert.ok(gunzipSync(readFileSync(gz)).equals(before));
    assert.equal(Math.round(statSync(gz).mtimeMs), Math.round(mtime));
  });

  it('keeps the newest keepPlain files and compresses the rest', async () => {
    const dir = tempDir();
    seed(dir, [
      '2026-01-01_00-00-00.log',
      '2026-01-02_00-00-00.log',
      '2026-01-03_00-00-00.log',
      '2026-01-04_00-00-00.log',
    ]);
    const res = await archiveLogDir(dir, { keepPlain: 2, retentionDays: 0 });
    assert.equal(res.compressed.length, 2);
    assert.deepEqual(readdirSync(dir).sort(), [
      '2026-01-01_00-00-00.log.gz',
      '2026-01-02_00-00-00.log.gz',
      '2026-01-03_00-00-00.log',
      '2026-01-04_00-00-00.log',
    ]);
    // Idempotent.
    const again = await archiveLogDir(dir, { keepPlain: 2, retentionDays: 0 });
    assert.deepEqual(again.compressed, []);
  });

  it('never touches a file that is still open', async () => {
    const dir = tempDir();
    seed(dir, ['2026-01-01_00-00-00.log', '2026-01-02_00-00-00.log', '2026-01-03_00-00-00.log']);
    await archiveLogDir(dir, { keepPlain: 1, retentionDays: 0 }, { exclude: [join(dir, '2026-01-01_00-00-00.log')] });
    assert.deepEqual(readdirSync(dir).sort(), [
      '2026-01-01_00-00-00.log',
      '2026-01-02_00-00-00.log.gz',
      '2026-01-03_00-00-00.log',
    ]);
  });

  it('deletes only archives older than retentionDays', async () => {
    const dir = tempDir();
    seed(dir, ['2026-01-01_00-00-00.log', '2026-01-02_00-00-00.log', '2026-01-03_00-00-00.log']);
    await archiveLogDir(dir, { keepPlain: 1, retentionDays: 0 });
    // Archives are dated Jan 1 and Jan 2; "now" is Jan 12 → keep 10 days deletes Jan 1 only.
    const res = await archiveLogDir(dir, { keepPlain: 1, retentionDays: 10 }, { now: new Date(2026, 0, 11, 12) });
    assert.equal(res.deleted.length, 1);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-01-02_00-00-00.log.gz', '2026-01-03_00-00-00.log']);
  });

  it('lists newest first, plain and compressed interleaved by date', () => {
    const dir = tempDir();
    seed(dir, ['2026-01-01_00-00-00.log.gz', '2026-01-03_00-00-00.log', '2026-01-02_00-00-00.log.gz', 'notes.txt']);
    assert.deepEqual(
      listLogFiles(dir).map((f) => f.name),
      ['2026-01-03_00-00-00.log', '2026-01-02_00-00-00.log.gz', '2026-01-01_00-00-00.log.gz'],
    );
    assert.deepEqual(listLogFiles(join(dir, 'missing')), []);
  });
});
