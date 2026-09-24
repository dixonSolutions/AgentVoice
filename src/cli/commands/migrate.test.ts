import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type BetterSqlite3 from 'better-sqlite3';
import { migrateCommand, transformConfig, transformEnv } from './migrate.js';

const scratch = mkdtempSync(join(tmpdir(), 'agentvoice-migrate-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SECRET = 'sk-test-DO-NOT-PRINT-4f9a';

/** Run the command with stdout/stderr captured, so we can assert no secret leaks. */
async function run(opts: Parameters<typeof migrateCommand>[0]): Promise<{ code: number; output: string }> {
  let output = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => ((output += String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => ((output += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await migrateCommand(opts), output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function source(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ settings: { runMode: 'test', runModes: { test: { backendPort: 5089 } }, serve: { repoDir: dir } }, projects: [{ name: 'p', path: 'rel/proj' }] }),
  );
  writeFileSync(
    join(dir, '.env'),
    ['# keys', `APP_TOKEN=${SECRET}-token`, `ELEVENLABS_API_KEY="${SECRET}"`, 'HTTPS_CERT_PATH=certs/host.crt', 'DB_PATH=./data/state.db', 'CONFIG_PATH=./config.json', ''].join('\n'),
  );
  return dir;
}

test('transformEnv re-anchors relative paths, drops layout keys, keeps the rest verbatim', () => {
  const env = transformEnv('# c\nA=1\nHTTPS_KEY_PATH="k/key.pem"\nDB_PATH=./data/x.db\nexport B=two\n', '/src');
  assert.deepEqual(env.keys, ['A', 'HTTPS_KEY_PATH', 'B']);
  assert.deepEqual(env.rewritten, ['HTTPS_KEY_PATH']);
  assert.deepEqual(env.dropped, ['DB_PATH']);
  assert.match(env.text, /^# c\nA=1\nHTTPS_KEY_PATH="\/src\/k\/key\.pem"\n# DB_PATH left behind/);
  assert.match(env.text, /export B=two\n$/);
});

test('transformConfig switches to serve, drops repoDir, absolutises project paths', () => {
  const cfg = transformConfig(
    JSON.stringify({ settings: { runMode: 'test', runModes: { test: { backendPort: 5100 } }, serve: { repoDir: '/src' } }, projects: [{ path: 'a' }, { path: '/abs' }] }),
    '/src',
  );
  const out = JSON.parse(cfg.text);
  assert.equal(out.settings.runMode, 'serve');
  assert.equal(out.settings.runModes.serve.backendPort, 5100);
  assert.equal(out.settings.serve.repoDir, undefined);
  assert.deepEqual(out.projects.map((p: { path: string }) => p.path), ['/src/a', '/abs']);
  assert.throws(() => transformConfig('{ nope', '/src'));
});

test('migrate copies config + .env at 0600 and never prints a secret', async () => {
  const src = source('one');
  const to = join(scratch, 'home-one');
  const { code, output } = await run({ source: src, to });
  assert.equal(code, 0);
  assert.ok(!output.includes(SECRET), 'a secret value reached the terminal');
  assert.match(output, /APP_TOKEN, ELEVENLABS_API_KEY, HTTPS_CERT_PATH/);

  const env = readFileSync(join(to, '.env'), 'utf8');
  assert.match(env, new RegExp(`ELEVENLABS_API_KEY="${SECRET}"`));
  assert.match(env, new RegExp(`HTTPS_CERT_PATH=${join(src, 'certs/host.crt').replace(/\//g, '\\/')}`));
  assert.doesNotMatch(env, /^DB_PATH=/m);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(to, '.env')).mode & 0o777, 0o600);
    assert.equal(statSync(join(to, 'config.json')).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(join(to, 'config.json'), 'utf8')).settings.runMode, 'serve');
  assert.equal(readFileSync(join(src, '.env'), 'utf8').includes('DB_PATH=./data/state.db'), true, 'source was modified');
});

test('migrate refuses to overwrite without --force, and backs up with it', async () => {
  const src = source('two');
  const to = join(scratch, 'home-two');
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, '.env'), 'APP_TOKEN=old-token-keep-me\n');

  const refused = await run({ source: src, to });
  assert.equal(refused.code, 1);
  assert.equal(readFileSync(join(to, '.env'), 'utf8'), 'APP_TOKEN=old-token-keep-me\n');

  const forced = await run({ source: src, to, force: true });
  assert.equal(forced.code, 0);
  const backups = readdirSync(to).filter((f) => f.startsWith('.env.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(to, backups[0]!), 'utf8'), 'APP_TOKEN=old-token-keep-me\n');
});

test('--dry-run writes nothing', async () => {
  const src = source('three');
  const to = join(scratch, 'home-three');
  const { code, output } = await run({ source: src, to, dryRun: true });
  assert.equal(code, 0);
  assert.ok(!existsSync(to));
  assert.ok(!output.includes(SECRET));
});

test('invalid config.json aborts before anything is written', async () => {
  const src = join(scratch, 'bad');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'config.json'), '{ not json');
  writeFileSync(join(src, '.env'), `APP_TOKEN=${SECRET}\n`);
  const to = join(scratch, 'home-bad');
  const { code, output } = await run({ source: src, to });
  assert.equal(code, 1);
  assert.ok(!existsSync(to));
  assert.ok(!output.includes(SECRET));
});

test('--with-data takes a consistent SQLite snapshot', async (t) => {
  let Database: typeof BetterSqlite3;
  try {
    Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch {
    t.skip('better-sqlite3 binding unavailable on this Node');
    return;
  }
  const src = source('four');
  mkdirSync(join(src, 'data'), { recursive: true });
  const db = new Database(join(src, 'data', 'state.db'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
  db.close();
  const to = join(scratch, 'home-four');
  const { code } = await run({ source: src, to, withData: true });
  assert.equal(code, 0);
  const copy = new Database(join(to, 'data', 'state.db'), { readonly: true });
  assert.equal((copy.prepare('SELECT v FROM t').get() as { v: string }).v, 'kept');
  copy.close();
});
