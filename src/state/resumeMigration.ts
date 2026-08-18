/**
 * One-time migration of the legacy `project.resume_id` column into the
 * per-provider `project_resume` table.
 *
 * The old column had no provider dimension, so a stored id could belong to any
 * of the three CLIs — and giving it to the wrong one is fatal (`claude --resume
 * <cursor chat id>` → "No conversation found with session ID: …", exit 1). So
 * rather than guessing, we ask each provider whether the id is in *its* session
 * store and file it under the one that claims it. An id nobody claims is
 * dropped: those projects simply start a fresh thread on their next run.
 *
 * Runs at boot, after registry reconciliation. Idempotent — the legacy column is
 * cleared as each row is migrated.
 */

import { getDb } from './db.js';
import { childLogger } from '../log.js';
import type { AgentClient } from '../config.js';
import { getProjectByName, setProjectResumeId, type Project } from './registry.js';
import { listAgentProviders } from '../providers/agents/registry.js';

const log = childLogger('resume-migration');

interface LegacyRow {
  name: string;
  resume_id: string;
}

/** The provider whose session store contains this id, if exactly one claims it. */
function attributeResumeId(project: Project, resumeId: string): AgentClient | null {
  const owners = listAgentProviders().filter(
    (provider) => provider.sessionStatus?.(project, resumeId) === 'present',
  );
  return owners.length === 1 ? owners[0]!.id : null;
}

export function migrateLegacyResumeIds(): void {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT name, resume_id FROM project
        WHERE resume_id IS NOT NULL AND TRIM(resume_id) != ''`,
    )
    .all() as LegacyRow[];
  if (rows.length === 0) return;

  const clear = db.prepare('UPDATE project SET resume_id = NULL WHERE name = @name');

  let migrated = 0;
  let dropped = 0;
  for (const row of rows) {
    const project = getProjectByName(row.name);
    const owner = project ? attributeResumeId(project, row.resume_id) : null;
    if (owner) {
      setProjectResumeId(row.name, row.resume_id, owner);
      migrated += 1;
      log.info({ project: row.name, provider: owner, resumeId: row.resume_id }, 'legacy resume id attributed');
    } else {
      dropped += 1;
      log.info(
        { project: row.name, resumeId: row.resume_id },
        'legacy resume id belongs to no installed CLI session store — dropped, next run starts a fresh thread',
      );
    }
    clear.run({ name: row.name });
  }

  log.info({ migrated, dropped }, 'legacy resume ids migrated to per-provider storage');
}
