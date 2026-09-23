/**
 * Silence the bridge's logger before anything can use it.
 *
 * Modules under src/ declare their child logger at import time
 * (`const log = childLogger('serve:install-mode')`); src/log.ts resolves each
 * one against whatever root is live when it logs. Importing this module first
 * still matters: it makes the root silent before any bridge module can log at
 * all — including while it is being imported — so nothing lands in the middle
 * of `status --json`.
 *
 * `silent` switches off every destination, the session log file included —
 * the CLI never writes into the bridge's logs/ folder.
 */

import { initLogger } from '../log.js';

initLogger('silent');
