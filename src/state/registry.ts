/**
 * Project registry — the ONLY source of workspace paths.
 *
 * On startup, reconcile the `project` table from config.json:
 *   - Add or update entries from config (preserving resume_id).
 *   - Disable entries that no longer appear in config (don't delete — keep history).
 *
 * All path resolution happens here. Callers supply a name (or alias);
 * this module returns the trusted absolute path from the registry.
 * Paths from callers are NEVER used directly.
 */

import { existsSync } from 'node:fs';
import { getDb } from './db.js';
import { getConfig, type ProjectConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from './configFile.js';
import { childLogger } from '../log.js';
import { foldedProjectMatch, projectMatchScore } from './projectMatch.js';

const log = childLogger('registry');

// ── DB row type ───────────────────────────────────────────────────────────────

export interface ProjectRow {
  name: string;
  path: string;
  aliases: string; // JSON array string
  description: string | null;
  resume_id: string | null;
  model: string | null;
  enabled: number; // 1 | 0
  created_at: string;
  updated_at: string;
}

export interface Project {
  name: string;
  path: string;
  aliases: string[];
  description: string | null;
  resumeId: string | null;
  model: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Reconciliation ────────────────────────────────────────────────────────────

function rowToProject(row: ProjectRow): Project {
  let aliases: string[] = [];
  try {
    aliases = JSON.parse(row.aliases) as string[];
  } catch {
    // Treat malformed aliases as empty rather than crashing.
  }
  return {
    name: row.name,
    path: row.path,
    aliases,
    description: row.description,
    resumeId: row.resume_id,
    model: row.model,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reconcile the project registry table from config.json.
 * Called once at bridge startup.
 *
 * - Projects in config → upsert (path/aliases/description/enabled updated).
 * - Projects not in config → set enabled=0 (soft-disable, history preserved).
 * - resume_id is NEVER overwritten by reconciliation.
 */
export function reconcileRegistry(): void {
  const db = getDb();
  const { projects } = getConfig();

  const configNames = new Set(projects.map((p) => p.name));

  // Upsert every project from config.
  const upsert = db.prepare(`
    INSERT INTO project (name, path, aliases, description, enabled, updated_at)
    VALUES (@name, @path, @aliases, @description, @enabled, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      path        = excluded.path,
      aliases     = excluded.aliases,
      description = excluded.description,
      enabled     = excluded.enabled,
      updated_at  = excluded.updated_at
  `);

  // Soft-disable projects removed from config.
  const disable = db.prepare(`
    UPDATE project SET enabled = 0, updated_at = datetime('now') WHERE name = @name
  `);

  const reconcile = db.transaction((cfgProjects: ProjectConfig[]) => {
    for (const p of cfgProjects) {
      if (!existsSync(p.path)) {
        log.warn({ project: p.name, path: p.path }, 'project path does not exist on disk');
      }
      upsert.run({
        name: p.name,
        path: p.path,
        aliases: JSON.stringify(p.aliases),
        description: p.description ?? null,
        enabled: p.enabled ? 1 : 0,
      });
    }

    // Disable DB rows not present in config.
    const existing = db
      .prepare('SELECT name FROM project WHERE enabled = 1')
      .all() as { name: string }[];
    for (const row of existing) {
      if (!configNames.has(row.name)) {
        disable.run({ name: row.name });
        log.info({ project: row.name }, 'project not in config — disabled in registry');
      }
    }
  });

  reconcile(projects);

  const count = (db.prepare('SELECT count(*) as n FROM project WHERE enabled = 1').get() as { n: number }).n;
  log.info({ enabledProjects: count }, 'registry reconciled');
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/** Return all enabled projects (no path exposed — callers get names/descriptions). */
export function listProjects(): Omit<Project, 'path'>[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM project WHERE enabled = 1 ORDER BY name')
    .all() as ProjectRow[];
  return rows.map((r) => {
    const { path: _path, ...rest } = rowToProject(r);
    void _path;
    return rest;
  });
}

/**
 * Resolve a name (or alias) to the trusted Project row.
 * Returns null if not found, disabled, or ambiguous.
 *
 * Resolution order:
 *   1. Exact name match (case-insensitive).
 *   2. Exact alias match (case-insensitive).
 *   3. Fuzzy/contains fallback on name + aliases (returns null on multiple matches).
 *   4. STT-normalized fold (e.g. "casa voice" → cursorvoice).
 */
export function resolveProject(input: string): Project | null {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM project WHERE enabled = 1')
    .all() as ProjectRow[];
  const projects = rows.map(rowToProject);

  const norm = input.trim().toLowerCase();

  // Pass 1: exact name
  const byName = projects.find((p) => p.name.toLowerCase() === norm);
  if (byName) return byName;

  // Pass 2: exact alias
  const byAlias = projects.find((p) => p.aliases.some((a) => a.toLowerCase() === norm));
  if (byAlias) return byAlias;

  // Pass 3: STT-normalized fold (casa voice → cursorvoice)
  const byFold = projects.filter((p) => foldedProjectMatch(norm, p.name, p.aliases));
  if (byFold.length === 1) return byFold[0] ?? null;

  // Pass 4: fuzzy contains (name or any alias contains the input)
  const fuzzy = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(norm) ||
      p.aliases.some((a) => a.toLowerCase().includes(norm)),
  );
  if (fuzzy.length === 1) return fuzzy[0] ?? null;

  // Pass 5: best single match by similarity score (STT typos)
  if (projects.length > 0) {
    const scored = projects
      .map((p) => ({ p, score: projectMatchScore(norm, p.name, p.aliases) }))
      .filter((x) => x.score >= 0.72)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1) return scored[0]!.p;
    if (scored.length > 1 && scored[0]!.score - scored[1]!.score >= 0.12) {
      return scored[0]!.p;
    }
  }

  return null;
}

/** Get a project by exact name, including disabled ones (for session recovery). */
export function getProjectByName(name: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM project WHERE name = ?').get(name) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : null;
}

// ── Session / model persistence ───────────────────────────────────────────────

/** Persist the cursor-agent session ID for a project (called after each successful run). */
export function setProjectResumeId(projectName: string, resumeId: string): void {
  getDb()
    .prepare(
      `UPDATE project SET resume_id = @resumeId, updated_at = datetime('now') WHERE name = @name`,
    )
    .run({ resumeId, name: projectName });
}

/** Clear the resume ID so the next submit starts a fresh thread. */
export function clearProjectResumeId(projectName: string): void {
  getDb()
    .prepare(
      `UPDATE project SET resume_id = NULL, updated_at = datetime('now') WHERE name = @name`,
    )
    .run({ name: projectName });
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface SessionState {
  sessionKey: string;
  activeProject: string | null;
  activeModel: string;
}

/** Bridge-wide default cursor-agent model (config.json). */
export function getDefaultActiveModel(): string {
  return getConfig().settings.defaultActiveModel ?? 'auto';
}

/** Persist default model for future sessions (config.json). */
export function persistDefaultActiveModel(model: string): void {
  const cfg = readConfigFile();
  cfg.settings.defaultActiveModel = model;
  writeConfigFile(cfg);
}

/** Update active_model on every stored session connection. */
export function setActiveModelForAllSessions(model: string): number {
  const result = getDb()
    .prepare(
      `UPDATE session_state SET active_model = @model, updated_at = datetime('now')`,
    )
    .run({ model });
  return result.changes;
}

/** Stamp model on all projects (registry metadata for admin / future per-project hints). */
export function setModelForAllProjects(model: string): number {
  const result = getDb()
    .prepare(`UPDATE project SET model = @model, updated_at = datetime('now')`)
    .run({ model });
  return result.changes;
}

/** Get (or create with defaults) the session state for a given session key. */
export function getSessionState(sessionKey: string): SessionState {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM session_state WHERE session_key = ?')
    .get(sessionKey) as { session_key: string; active_project: string | null; active_model: string } | undefined;

  if (!row) {
    const defaultModel = getDefaultActiveModel();
    db.prepare(
      `INSERT INTO session_state (session_key, active_model) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    ).run(sessionKey, defaultModel);
    return { sessionKey, activeProject: null, activeModel: defaultModel };
  }

  return {
    sessionKey: row.session_key,
    activeProject: row.active_project,
    activeModel: row.active_model,
  };
}

/** Update the active project for a session. */
export function setActiveProject(sessionKey: string, projectName: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_state (session_key, active_project, updated_at)
       VALUES (@sessionKey, @project, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET
         active_project = excluded.active_project,
         updated_at     = excluded.updated_at`,
    )
    .run({ sessionKey, project: projectName });
}

/** Update the active model for a session. */
export function setActiveModel(sessionKey: string, model: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_state (session_key, active_model, updated_at)
       VALUES (@sessionKey, @model, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET
         active_model = excluded.active_model,
         updated_at   = excluded.updated_at`,
    )
    .run({ sessionKey, model });
}

/** Copy active project/model from one session key to another (e.g. MCP connection bind). */
export function cloneSessionState(fromKey: string, toKey: string): void {
  const from = getSessionState(fromKey);
  if (from.activeProject) {
    setActiveProject(toKey, from.activeProject);
  }
  if (from.activeModel) {
    setActiveModel(toKey, from.activeModel);
  }
}
