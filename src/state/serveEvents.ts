/**
 * Persisted serve step log — one row per phase of a manual rebase / restart / health action.
 */

import { getDb } from './db.js';

export type ServeEventStatus = 'ok' | 'skip' | 'warn' | 'error';

export interface ServeEventRow {
  id: number;
  run_id: string;
  ts: string;
  step: string;
  status: ServeEventStatus;
  detail: string | null;
}

export function addServeEvent(params: {
  runId: string;
  step: string;
  status: ServeEventStatus;
  detail?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO serve_event (run_id, step, status, detail)
       VALUES (@runId, @step, @status, @detail)`,
    )
    .run({
      runId: params.runId,
      step: params.step,
      status: params.status,
      detail: params.detail ?? null,
    });
}

export function listServeEvents(limit = 50): ServeEventRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return getDb()
    .prepare(
      `SELECT id, run_id, ts, step, status, detail
       FROM serve_event
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(capped) as ServeEventRow[];
}
