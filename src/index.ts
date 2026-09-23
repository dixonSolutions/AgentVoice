/**
 * AgentVoice — bridge entry point.
 *
 * Boot sequence:
 *   1. Load .env (dotenv)
 *   2. Load + validate config (config.ts)
 *   3. Initialise logger (log.ts) — terminal + a date-named session .log file,
 *      and voice-session transcripts (logging/)
 *   4. Open DB + run migrations (db.ts)
 *   5. Reconcile project registry (registry.ts) + migrate legacy resume ids
 *   6. Mark orphaned jobs (jobs.ts)
 *   7. Start Fastify server (server.ts), then compress older log files
 *   8. Register graceful shutdown handlers
 */

import 'dotenv/config';

import { loadConfig } from './config.js';
import { getRunModeInfo } from './runMode.js';
import { closeLogger, getLogger } from './log.js';
import { archiveOldLogs, startLogging } from './logging/setup.js';
import { closeTranscripts } from './logging/transcripts.js';
import { getDb, closeDb } from './state/db.js';
import { reconcileRegistry } from './state/registry.js';
import { startProjectDiscovery, synchronizeProjectDiscovery } from './state/projectDiscovery.js';
import { migrateLegacyResumeIds } from './state/resumeMigration.js';
import { markOrphanedJobs, markOrphanedVoiceAgentRuns } from './state/jobs.js';
import { parkRunsForRestart, resumeInterruptedJobs } from './executor/restartSurvival.js';
import { wireAwayPolicy } from './state/awayPolicy.js';
import { getActiveProvider } from './providers/agents/registry.js';
import { getActiveHostingProvider } from './providers/hosting/registry.js';
import { killActiveAgent } from './executor/agentSingleton.js';
import { killVoiceAgent } from './executor/voiceAgent.js';
import { buildServer, startServer } from './server.js';
import { startServe } from './serve/index.js';

async function main(): Promise<void> {
  // 1. Config (must be first — everything else depends on it)
  const config = loadConfig();

  // 2. Logger — terminal, session .log file, voice transcripts
  startLogging(config);
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

  // 4. Discovery is an in-process source of allowlisted project paths. It runs
  // before the registry so newly found Git worktrees are safe to select on the
  // first request, then continues watching while the bridge is alive.
  synchronizeProjectDiscovery();

  // 4a. Registry reconciliation (upsert projects from config.json)
  reconcileRegistry();
  const stopProjectDiscovery = startProjectDiscovery();

  // 4b. File any legacy provider-agnostic resume id under the CLI that owns it.
  migrateLegacyResumeIds();

  // 5. Orphan cleanup (jobs left running from a previous bridge process).
  //     Jobs the shutdown path parked as `interrupted` are skipped here — they
  //     are resumed below rather than failed (docs/36 §5).
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

  // 6b. Presence drives the away budget; the grace window comes from config.
  wireAwayPolicy();

  // 6c. Pick up anything the last shutdown parked mid-task. After the server
  //     is listening, so a resumed agent's MCP connection has somewhere to go.
  void resumeInterruptedJobs()
    .then((outcome) => {
      if (outcome.resumed + outcome.abandoned > 0) {
        log.info(outcome, 'interrupted runs from the previous process settled');
      }
    })
    .catch((err: unknown) => log.error({ err }, 'resuming interrupted runs failed'));

  await startServe();

  // Only now is this provably the one live process for its run profile (the
  // port bind would have failed otherwise), so older files are safe to gzip.
  void archiveOldLogs(config);

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
    // Park before killing: once the processes are gone the only record of what
    // they were doing is the job row.
    try {
      parkRunsForRestart();
    } catch (err) {
      log.error({ err }, 'could not park running jobs for resume');
    }
    killActiveAgent('bridge shutdown');
    killVoiceAgent('bridge shutdown');
    stopProjectDiscovery();
    try {
      await app.close();
      closeDb();
      log.info('shutdown complete');
      closeTranscripts(`bridge shutdown (${signal})`);
      closeLogger(signal);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      closeTranscripts('bridge shutdown (error)');
      closeLogger('error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    closeTranscripts('bridge crashed');
    closeLogger('crash — uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled promise rejection',
    );
    closeTranscripts('bridge crashed');
    closeLogger('crash — unhandled rejection');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // Logger may not be initialised yet if config fails — fall back to console.
  console.error('Fatal startup error:', err instanceof Error ? err.message : String(err));
  // If it was, make sure the session file records why this run ended.
  getLogger().fatal({ err }, 'fatal startup error');
  closeLogger('fatal startup error');
  process.exit(1);
});
