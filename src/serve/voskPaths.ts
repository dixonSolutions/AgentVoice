/**
 * Where the Vosk wake-word model lives (docs/38).
 *
 * `agentvoice prepare-vosk` used to write the ~41 MB model into
 * `<root>/web/dist/vosk`, which is fine for a clone or an npm install and
 * impossible for a distro package: `/usr/lib/agentvoice` belongs to root and
 * to the package manager, so the command would fail for every .deb user and
 * wake words would simply never work for them.
 *
 * The model therefore has a user-owned home — `~/.agentvoice/vosk` — which the
 * bridge serves in preference to the packaged copy. A clone keeps writing into
 * `web/public/` so the file survives the next `ng build`.
 *
 * Kept separate from cli/home.ts so the bridge can read it without pulling the
 * management CLI into the server bundle.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectInstallMode, type InstallMode } from './installMode.js';

export interface VoskPaths {
  /**
   * Directories to serve `/vosk/*` from, highest priority first. The user's
   * own copy wins so an upgrade of the package cannot shadow a model they
   * already downloaded.
   */
  serveFrom: string[];
  /** Where `prepare-vosk` should write. Always a directory the user owns. */
  writeTo: string;
  /** True when the packaged web root cannot be written to. */
  packagedRootReadOnly: boolean;
}

/** `~/.agentvoice`, or `AGENTVOICE_HOME` when the user pointed it elsewhere. */
export function agentVoiceHome(): string {
  const fromEnv = process.env['AGENTVOICE_HOME'];
  return fromEnv ? fromEnv : join(homedir(), '.agentvoice');
}

export function voskPaths(
  opts: { root?: string; mode?: InstallMode; home?: string } = {},
): VoskPaths {
  const install = detectInstallMode();
  const root = opts.root ?? install.root;
  const mode = opts.mode ?? install.mode;
  const home = opts.home ?? agentVoiceHome();

  const userDir = join(home, 'vosk');
  const distDir = join(root, 'web', 'dist', 'vosk');
  const publicDir = join(root, 'web', 'public', 'vosk');

  // A clone rebuilds web/dist on every build, so the model has to live in
  // web/public or it is deleted by the next `ng build`.
  if (mode === 'git' && existsSync(join(root, 'web', 'public'))) {
    return { serveFrom: [userDir, publicDir, distDir], writeTo: publicDir, packagedRootReadOnly: false };
  }

  const readOnly = mode === 'system' || !isWritable(join(root, 'web'));
  return {
    serveFrom: [userDir, distDir],
    // Never write into a package-manager-owned tree, even if the process
    // happens to be running as root: the files would be unowned by any package
    // and an upgrade would leave them behind.
    writeTo: readOnly ? userDir : distDir,
    packagedRootReadOnly: readOnly,
  };
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
