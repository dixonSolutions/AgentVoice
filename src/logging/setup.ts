/**
 * Wire config → logger + transcripts at startup, and tidy old files once the
 * bridge is known to be the only live process for its profile.
 */

import type { AppConfig } from '../config.js';
import { childLogger, getSessionLog, initLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { getAppVersionInfo } from '../state/appVersion.js';
import { archiveLogDir } from './logFiles.js';
import { logFolderPath } from './logPaths.js';
import { archiveTranscripts, configureTranscripts } from './transcripts.js';

const log = childLogger('logging');

/** Initialise the root logger (terminal + session file) and transcript recording. */
export function startLogging(config: AppConfig): void {
  const { settings } = config;
  const logging = settings.logging;
  const runMode = settings.runMode;
  const retention = {
    keepPlain: logging.keepPlain,
    maxFileMb: logging.maxFileMb,
    retentionDays: logging.retentionDays,
  };

  initLogger({
    level: settings.logLevel,
    ...(logging.files
      ? {
          files: {
            dir: logFolderPath(logging, runMode, 'bridge'),
            level: logging.fileLevel,
            ...retention,
            describe: () => {
              const { appVersion, gitCommit } = getAppVersionInfo();
              return {
                version: gitCommit ? `${appVersion} (${gitCommit})` : appVersion,
                node: process.version,
                pid: process.pid,
                runMode,
                agent: settings.agentClient,
                workflow: settings.workflow.default,
                cwd: process.cwd(),
              };
            },
          },
        }
      : {}),
  });

  configureTranscripts({
    enabled: logging.transcripts,
    dir: logFolderPath(logging, runMode, 'transcripts'),
    ...retention,
    describe: () => {
      let agent: string = settings.agentClient;
      try {
        agent = getActiveProvider().displayName;
      } catch {
        // provider registry not ready — the id is still informative
      }
      return {
        agent,
        workflow: settings.workflow.default,
        input: settings.voice.inputMode,
        pid: process.pid,
      };
    },
  });

  const sessionLog = getSessionLog();
  log.info(
    {
      logFile: sessionLog?.path ?? null,
      fileLevel: logging.files ? logging.fileLevel : null,
      transcripts: logging.transcripts ? logFolderPath(logging, runMode, 'transcripts') : null,
    },
    'logging started',
  );
}

/**
 * Compress files from earlier sessions. Called after the server has bound its
 * port — proof that no other process of this profile is still writing to the
 * same folders.
 */
export async function archiveOldLogs(config: AppConfig): Promise<void> {
  const { logging, runMode } = config.settings;
  const policy = { keepPlain: logging.keepPlain, retentionDays: logging.retentionDays };
  const results = await Promise.allSettled([
    getSessionLog()?.archive() ?? Promise.resolve(null),
    archiveTranscripts(),
    archiveLogDir(logFolderPath(logging, runMode, 'console'), policy),
  ]);

  let compressed = 0;
  let deleted = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      log.warn({ err: r.reason }, 'log archiving failed');
      continue;
    }
    if (!r.value) continue;
    compressed += r.value.compressed.length;
    deleted += r.value.deleted.length;
    for (const e of r.value.errors) log.warn({ detail: e }, 'could not archive a log file');
  }
  if (compressed || deleted) {
    log.info({ compressed, deleted }, 'archived older log files');
  }
}
