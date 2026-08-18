/**
 * AgentVoice — bridge entry point.
 *
 * Boot sequence:
 *   1. Load .env (dotenv)
 *   2. Load + validate config (config.ts)
 *   3. Initialise logger (log.ts)
 *   4. Open DB + run migrations (db.ts)
 *   5. Reconcile project registry (registry.ts) + migrate legacy resume ids
 *   6. Mark orphaned jobs (jobs.ts)
 *   7. Start Fastify server (server.ts)
 *   8. Register graceful shutdown handlers
 */

import 'dotenv/config';

import { loadConfig } from './config.js';
import { getRunModeInfo } from './runMode.js';
import { initLogger, getLogger } from './log.js';
import { getDb, closeDb } from './state/db.js';
import { reconcileRegistry } from './state/registry.js';
import { migrateLegacyResumeIds } from './state/resumeMigration.js';
import { markOrphanedJobs, markOrphanedVoiceAgentRuns } from './state/jobs.js';
import { getActiveProvider } from './providers/agents/registry.js';
import { getActiveHostingProvider } from './providers/hosting/registry.js';
import { killActiveAgent } from './executor/agentSingleton.js';
import { killVoiceAgent } from './executor/voiceAgent.js';
import { buildServer, startServer } from './server.js';
import { startServe } from './serve/index.js';

async function main(): Promise<void> {
  // 1. Config (must be first — everything else depends on it)
  const config = loadConfig();

  // 2. Logger
  initLogger(config.settings.logLevel);
  const log = getLogger();

  log.info('agentvoice bridge starting');

  const provider = getActiveProvider();
  const agentBinPath = provider.resolveBin();
  if (provider.isInstalled()) {
    log.info({ provider: provider.id, agentBinPath }, 'agent CLI resolved');
  } else {
    log.warn(
      { provider: provider.id, agentBinPath },
      'active agent CLI not found — voice turns will fail until it is installed',
    );
  }

  // 3. Database + migrations
  getDb();

  // 4. Registry reconciliation (upsert projects from config.json)
  reconcileRegistry();

  // 4b. File any legacy provider-agnostic resume id under the CLI that owns it.
  migrateLegacyResumeIds();

  // 5. Orphan cleanup (jobs left running from a previous bridge process)
  const orphanCount = markOrphanedJobs();
  if (orphanCount > 0) {
    log.warn({ orphanCount }, 'cleaned up orphaned jobs from previous run');
  }

  const orphanVoiceCount = markOrphanedVoiceAgentRuns();
  if (orphanVoiceCount > 0) {
    log.warn({ orphanVoiceCount }, 'cleaned up orphaned voice agent runs from previous run');
  }

  // 6. Start server
  const app = await buildServer();
  await startServer(app);

  await startServe();

  const run = getRunModeInfo(config.settings);

  // Re-point the active tunnel/proxy at this process's port, in case it
  // changed since the last run (replaces the old sync-tailscale-serve.sh
  // step for every hosting provider, not just Tailscale).
  if (run.runMode === 'serve') {
    const hosting = getActiveHostingProvider();
    hosting
      .sync()
      .then(() => log.info({ hostingProvider: hosting.id }, 'hosting provider synced'))
      .catch((err: unknown) =>
        log.warn(
          { hostingProvider: hosting.id, err: err instanceof Error ? err.message : String(err) },
          'hosting provider sync failed — public URL may be stale',
        ),
      );
  }

  log.info(
    {
      projects: config.projects.filter((p) => p.enabled).length,
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      defaultWorkflow: config.settings.workflow.default,
    },
    'agentvoice bridge ready',
  );

  // ── Graceful shutdown ────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, 'shutdown signal received');
    killActiveAgent('bridge shutdown');
    killVoiceAgent('bridge shutdown');
    try {
      await app.close();
      closeDb();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'unhandled promise rejection');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // Logger may not be initialised yet if config fails — fall back to console.
  console.error('Fatal startup error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
