/**
 * SQLite state store (better-sqlite3).
 *
 * Single-user home service — synchronous API is fine here and keeps the
 * executor code simple. WAL mode + foreign keys enabled by default.
 *
 * Migrations run inline at startup (idempotent CREATE TABLE IF NOT EXISTS).
 * Schema is the canonical definition from docs/07-data-and-deployment.md.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('db');

let _db: Database.Database | null = null;

// ── Schema ─────────────────────────────────────────────────────────────────────

const MIGRATION_SQL = `
  -- Allowlisted projects. THE ONLY source of workspace paths.
  CREATE TABLE IF NOT EXISTS project (
    name        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    resume_id   TEXT,
    model       TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Sticky per-session state (single-user; session_key = WS connection id or "default").
  CREATE TABLE IF NOT EXISTS session_state (
    session_key    TEXT PRIMARY KEY,
    active_project TEXT REFERENCES project(name),
    active_model   TEXT NOT NULL DEFAULT 'auto',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cached model list from cursor-agent models. Single-row; id = 1 enforced.
  -- Superseded by provider_model_cache (kept for migration only — see below).
  CREATE TABLE IF NOT EXISTS model_cache (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    fetched_at    TEXT NOT NULL,
    models_json   TEXT NOT NULL
  );

  -- Cached model list per agent provider (cursor / codex / claude-code), so
  -- switching agentClient never clobbers another provider's cache.
  CREATE TABLE IF NOT EXISTS provider_model_cache (
    provider      TEXT PRIMARY KEY,
    fetched_at    TEXT NOT NULL,
    models_json   TEXT NOT NULL
  );

  -- One row per cursor_submit invocation.
  CREATE TABLE IF NOT EXISTS job (
    id           TEXT PRIMARY KEY,
    project      TEXT NOT NULL REFERENCES project(name),
    prompt       TEXT NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'agent',
    status       TEXT NOT NULL,
    pid          INTEGER,
    session_id   TEXT,
    checkpoint   TEXT,
    summary      TEXT,
    diffstat     TEXT,
    error        TEXT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );

  -- Streaming progress events for narration + debugging.
  CREATE TABLE IF NOT EXISTS job_event (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id    TEXT NOT NULL REFERENCES job(id),
    ts        TEXT NOT NULL DEFAULT (datetime('now')),
    kind      TEXT NOT NULL,
    payload   TEXT
  );

  -- Security audit: every tool call crossing the trust boundary.
  CREATE TABLE IF NOT EXISTS audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL DEFAULT (datetime('now')),
    tool      TEXT NOT NULL,
    project   TEXT,
    args_hash TEXT,
    result    TEXT,
    reason    TEXT
  );

  -- Conversational voice agent (cursor_native auto-dispatch).
  CREATE TABLE IF NOT EXISTS voice_agent_run (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL REFERENCES project(name),
    pid         INTEGER,
    session_id  TEXT,
    mcp_session TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT
  );

  -- Serve self-hosting run log (rebase / restart / health steps).
  CREATE TABLE IF NOT EXISTS serve_event (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL,
    ts      TEXT NOT NULL DEFAULT (datetime('now')),
    step    TEXT NOT NULL,
    status  TEXT NOT NULL,
    detail  TEXT
  );
`;

// ── Indexes (performance) ─────────────────────────────────────────────────────

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_job_project    ON job(project);
  CREATE INDEX IF NOT EXISTS idx_job_status     ON job(status);
  CREATE INDEX IF NOT EXISTS idx_job_event_job  ON job_event(job_id);
  CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_tool     ON audit(tool);
  CREATE INDEX IF NOT EXISTS idx_voice_agent_status ON voice_agent_run(status);
  CREATE INDEX IF NOT EXISTS idx_voice_agent_project ON voice_agent_run(project);
  CREATE INDEX IF NOT EXISTS idx_serve_run ON serve_event(run_id);
  CREATE INDEX IF NOT EXISTS idx_serve_ts ON serve_event(ts);
`;

/** Carry legacy heartbeat_event rows into serve_event on existing databases. */
function migrateServeEventTable(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('heartbeat_event', 'serve_event')`)
    .all() as Array<{ name: string }>;
  const names = new Set(tables.map((t) => t.name));
  if (names.has('heartbeat_event') && !names.has('serve_event')) {
    db.exec('ALTER TABLE heartbeat_event RENAME TO serve_event');
    log.info('migrated heartbeat_event → serve_event');
  }
}

/** Carry the legacy single-row model_cache (always Cursor) into provider_model_cache once. */
function migrateProviderModelCache(db: Database.Database): void {
  const legacy = db.prepare('SELECT fetched_at, models_json FROM model_cache WHERE id = 1').get() as
    | { fetched_at: string; models_json: string }
    | undefined;
  if (!legacy) return;
  const existing = db.prepare('SELECT 1 FROM provider_model_cache WHERE provider = ?').get('cursor');
  if (existing) return;
  db.prepare(
    `INSERT INTO provider_model_cache (provider, fetched_at, models_json) VALUES ('cursor', @fetched_at, @models_json)`,
  ).run(legacy);
  log.info('migrated model_cache (cursor) → provider_model_cache');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the singleton DB, initialising on first call. */
export function getDb(): Database.Database {
  if (_db) return _db;

  const { env } = getConfig();
  const dbPath = resolve(env.DB_PATH);

  // Ensure the data directory exists before opening.
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  migrateServeEventTable(_db);

  _db.exec(MIGRATION_SQL);
  _db.exec(INDEX_SQL);

  migrateProviderModelCache(_db);

  log.info({ dbPath }, 'database ready');

  return _db;
}

/** Close the DB connection (called on graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info('database closed');
  }
}

/**
 * Insert a row into the `audit` table.
 * Called by every tool handler after token/schema/allowlist checks.
 */
export function writeAudit(entry: {
  tool: string;
  project?: string;
  args_hash?: string;
  result: 'ok' | 'rejected' | 'error';
  reason?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit (tool, project, args_hash, result, reason)
     VALUES (@tool, @project, @args_hash, @result, @reason)`,
  ).run({
    tool: entry.tool,
    project: entry.project ?? null,
    args_hash: entry.args_hash ?? null,
    result: entry.result,
    reason: entry.reason ?? null,
  });
}
