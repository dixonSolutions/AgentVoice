/**
 * Silence the bridge's logger before anything can use it.
 *
 * Modules under src/ take their child logger at import time
 * (`const log = childLogger('serve:install-mode')`), and a child captures
 * whatever root logger exists at that moment. So this cannot be a function the
 * CLI calls from main() — by then detectInstallMode already holds a child of a
 * default, info-level logger and its first call prints a JSON line into the
 * middle of `status --json`.
 *
 * Importing this module first is what makes it work: ES modules evaluate in
 * import order, so the root logger is created silent before any bridge module
 * reaches for one.
 *
 * isTTY is masked across the call because log.ts routes through pino-pretty on
 * a TTY, and pino-pretty is a devDependency that an installed package does not
 * have.
 */

import { initLogger } from '../log.js';

const isTTY = process.stdout.isTTY;
Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
initLogger('silent');
Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
