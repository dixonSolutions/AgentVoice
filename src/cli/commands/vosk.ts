/**
 * `agentvoice prepare-vosk` — fetch the wake-word model.
 *
 * Vosk's small English model is ~41 MB of weights. It is not in the published
 * tarball: shipping it would more than double the download for every install,
 * including the many that never turn wake words on. So it is fetched here, once,
 * into whichever directory this install serves static assets from.
 *
 * The PWA asks for `/vosk/model.tar.gz` at runtime (see web/src/model-download.ts).
 * A clone serves that out of `web/public/` — Angular copies it to `web/dist/` at
 * build time — while an installed package serves `web/dist/` directly and has no
 * build step to run, so the file has to land there.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { detectInstallMode } from '../../serve/installMode.js';
import { bold, dim, fail, green, say, yellow } from '../out.js';

const MODEL_ZIP_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const MODEL_DIR_NAME = 'vosk-model-small-en-us-0.15';
/** Below this, whatever we fetched is an error page, not a model. */
const MIN_PLAUSIBLE_BYTES = 10 * 1024 * 1024;

/**
 * Where this install serves `/vosk/model.tar.gz` from.
 *
 * A clone gets `web/public` so the file survives the next `ng build`; anything
 * else gets `web/dist`, which is what actually gets served and is the only
 * directory an installed package has.
 */
function voskDir(root: string, mode: string): string {
  const publicDir = join(root, 'web', 'public', 'vosk');
  if (mode === 'git' && existsSync(join(root, 'web', 'public'))) return publicDir;
  return join(root, 'web', 'dist', 'vosk');
}

export async function prepareVoskCommand(opts: { force?: boolean } = {}): Promise<void> {
  const install = detectInstallMode();
  const dir = voskDir(install.root, install.mode);
  const target = join(dir, 'model.tar.gz');

  if (existsSync(target) && !opts.force) {
    const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
    say(`${green('ok')}  Wake-word model already present — ${target} (${mb} MB)`);
    say(dim('  Re-download with: agentvoice prepare-vosk --force'));
    return;
  }

  // tar does the repacking; there is no point reimplementing it in JS, and
  // every platform we support has it.
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('`tar` is required to prepare the wake-word model and was not found on PATH.');
    process.exitCode = 1;
    return;
  }

  const work = resolve(tmpdir(), `agentvoice-vosk-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'model.zip');

  try {
    say(`${bold('Downloading')} ${MODEL_ZIP_URL}`);
    const res = await fetch(MODEL_ZIP_URL);
    if (!res.ok || !res.body) {
      throw new Error(`download failed (${res.status} ${res.statusText})`);
    }
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));

    const size = statSync(zip).size;
    if (size < MIN_PLAUSIBLE_BYTES) {
      throw new Error(`downloaded only ${size} bytes — that is not the model`);
    }

    say(`${bold('Unpacking')} ${dim(`${(size / 1024 / 1024).toFixed(1)} MB`)}`);
    execFileSync('unzip', ['-q', '-o', zip, '-d', work], { stdio: 'inherit' });

    const extracted = join(work, MODEL_DIR_NAME);
    if (!existsSync(extracted)) {
      throw new Error(`expected ${MODEL_DIR_NAME}/ inside the archive`);
    }

    // vosk-browser wants the model's *contents* at the tarball root, not the
    // versioned directory around them.
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-czf', target, '-C', extracted, '.'], { stdio: 'inherit' });

    const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
    say(`${green('ok')}  Wake-word model ready — ${target} (${mb} MB)`);
    say(dim('  Restart the bridge, then enable wake words in Config → Voice & Controls.'));
  } catch (err) {
    fail(`Could not prepare the wake-word model: ${err instanceof Error ? err.message : String(err)}`);
    say(`${yellow('warn')}  Wake words stay unavailable; on-screen Speak / Cancel still work.`);
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
