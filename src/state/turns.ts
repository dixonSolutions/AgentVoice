/**
 * Conversation transcript.
 *
 * A spoken turn is otherwise unrecorded: the coding CLI keeps its own thread in
 * a private format the bridge does not read, and voice_agent_run stores process
 * rows, not words. That meant reopening the desk panel — or picking a thread up
 * on another device — always started from a blank page.
 *
 * Only what the user actually said and what the agent actually spoke is stored.
 * Tool activity and narration stay out: they belong in the logs.
 */

import { getDb } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('turns');

export type TurnRole = 'user' | 'agent';

export interface TurnRecord {
  id: number;
  project: string;
  sessionId: string | null;
  role: TurnRole;
  text: string;
  source: string | null;
  at: string;
}

/** Longest line worth keeping — a runaway agent should not fill the database. */
const MAX_TEXT = 8_000;

export function recordTurn(input: {
  project: string;
  sessionId?: string | null;
  role: TurnRole;
  text: string;
  source?: string | null;
}): void {
  const text = input.text.trim();
  if (!text) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO turn (project, session_id, role, text, source)
         VALUES (@project, @sessionId, @role, @text, @source)`,
      )
      .run({
        project: input.project,
        sessionId: input.sessionId ?? null,
        role: input.role,
        text: text.slice(0, MAX_TEXT),
        source: input.source ?? null,
      });
  } catch (err) {
    // Never let bookkeeping break a live turn.
    log.warn({ err, project: input.project, role: input.role }, 'failed to record turn');
  }
}

/**
 * Most recent turns for a project, oldest first so a client can replay them
 * straight into a transcript. Pass a session to scope it to one thread.
 */
export function listTurns(project: string, opts: { sessionId?: string | null; limit?: number } = {}): TurnRecord[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.sessionId
    ? getDb()
        .prepare(
          `SELECT * FROM (
             SELECT * FROM turn WHERE project = @project AND session_id = @sessionId
             ORDER BY id DESC LIMIT @limit
           ) ORDER BY id ASC`,
        )
        .all({ project, sessionId: opts.sessionId, limit })
    : getDb()
        .prepare(
          `SELECT * FROM (
             SELECT * FROM turn WHERE project = @project
             ORDER BY id DESC LIMIT @limit
           ) ORDER BY id ASC`,
        )
        .all({ project, limit });

  return (rows as { id: number; project: string; session_id: string | null; role: string; text: string; source: string | null; at: string }[]).map(
    (r) => ({
      id: r.id,
      project: r.project,
      sessionId: r.session_id,
      role: r.role as TurnRole,
      text: r.text,
      source: r.source,
      at: r.at,
    }),
  );
}
