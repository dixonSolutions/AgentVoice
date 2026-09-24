/**
 * `agentvoice prepare-vosk` — fetch the wake-word model now.
 *
 * Vosk's small English model is ~41 MB of weights and is not in the published
 * tarball. The bridge fetches it on its own the first time it boots
 * (src/serve/ensureVoskModel.ts); this command runs that same preparation
 * ahead of time — before going offline, or to repair a bad download with
 * `--force`.
 *
 * It deliberately calls the bridge's code rather than keeping its own
 * download: the two used to write to different directories, so a model this
 * command fetched into the package was invisible to the bridge's check,
 * downloaded again, and lost on the next `npm update`. Both now land in
 * `<AGENTVOICE_HOME>/vosk`, which no upgrade touches.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureVoskModel, findPreparedModel, onVoskStatus } from '../../serve/ensureVoskModel.js';
import { voskPaths } from '../../serve/voskPaths.js';
import { bold, dim, fail, green, note, say, yellow } from '../out.js';

export async function prepareVoskCommand(opts: { force?: boolean } = {}): Promise<void> {
  const dir = voskPaths().serveFrom[0];
  if (!dir) {
    fail('no directory to prepare the wake-word model in');
    process.exitCode = 1;
    return;
  }
  const target = join(dir, 'model.tar.gz');

  const existing = await findPreparedModel();
  if (existing && !opts.force) {
    say(`${green('ok')}  Wake-word model already present — ${existing} (${megabytes(existing)} MB)`);
    say(dim('  Re-download with: agentvoice prepare-vosk --force'));
    return;
  }
  if (opts.force && existsSync(target)) rmSync(target, { force: true });

  let lastPercent = -1;
  const unsubscribe = onVoskStatus((status) => {
    if (status.phase === 'downloading') {
      const percent = status.fraction === null ? null : Math.floor(status.fraction * 100);
      if (percent === null && lastPercent === -1) {
        say(bold('Downloading the wake-word model…'));
        lastPercent = 0;
      } else if (percent !== null && percent >= lastPercent + 10) {
        lastPercent = percent - (percent % 10);
        note(dim(`  ${lastPercent}%`));
      }
    } else if (status.phase === 'unpacking') {
      say(bold('Unpacking'));
    }
  });

  try {
    await ensureVoskModel({ force: opts.force === true });
    say(`${green('ok')}  Wake-word model ready — ${target} (${megabytes(target)} MB)`);
    say(dim('  Enable wake words in Config → Voice & Controls. A running bridge picks it up without a restart.'));
  } catch (err) {
    fail(`Could not prepare the wake-word model: ${err instanceof Error ? err.message : String(err)}`);
    say(`${yellow('warn')}  Wake words stay unavailable; on-screen Speak / Cancel still work.`);
    process.exitCode = 1;
  } finally {
    unsubscribe();
  }
}

function megabytes(path: string): string {
  return (statSync(path).size / 1024 / 1024).toFixed(1);
}
