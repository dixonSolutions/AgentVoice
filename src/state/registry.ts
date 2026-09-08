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
import { getConfig, type AgentClient, type ProjectConfig } from '../config.js';
import type { ModelSelection } from '../providers/agents/types.js';
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
  /** LEGACY — provider-agnostic resume id. Read only by the boot migration. */
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
  /** Resume thread for the *currently active* agent CLI only (see project_resume). */
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
    // NOT row.resume_id — that column is provider-agnostic and handing one
    // CLI's thread id to another kills the spawn (see project_resume).
    resumeId: getProjectResumeId(row.name),
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

/**
 * Resume threads are per (project, agent CLI).
 *
 * Cursor, Codex and Claude Code each store conversations in their own private
 * format and namespace, so a thread id from one is meaningless to the others.
 * Keeping a single id per project meant that switching agentClient handed the
 * new CLI a foreign id — `claude --resume <cursor chat id>` exits 1 with
 * "No conversation found with session ID: …", the voice agent dies before it
 * can speak, and the user just hears the "I finished but did not speak aloud"
 * fallback on every single turn.
 */
function activeAgentClient(): AgentClient {
  return getConfig().settings.agentClient;
}

/** Resume id for a project under one CLI (default: the active one). */
export function getProjectResumeId(
  projectName: string,
  provider: AgentClient = activeAgentClient(),
): string | null {
  const row = getDb()
    .prepare('SELECT resume_id FROM project_resume WHERE project = @name AND provider = @provider')
    .get({ name: projectName, provider }) as { resume_id: string } | undefined;
  return row?.resume_id ?? null;
}

/** Persist the agent CLI's session ID for a project (called after each successful run). */
export function setProjectResumeId(
  projectName: string,
  resumeId: string,
  provider: AgentClient = activeAgentClient(),
): void {
  getDb()
    .prepare(
      `INSERT INTO project_resume (project, provider, resume_id, updated_at)
       VALUES (@name, @provider, @resumeId, datetime('now'))
       ON CONFLICT(project, provider) DO UPDATE SET
         resume_id  = excluded.resume_id,
         updated_at = excluded.updated_at`,
    )
    .run({ name: projectName, provider, resumeId });
}

/** Clear the resume ID so the next submit starts a fresh thread. */
export function clearProjectResumeId(
  projectName: string,
  provider: AgentClient = activeAgentClient(),
): void {
  getDb()
    .prepare('DELETE FROM project_resume WHERE project = @name AND provider = @provider')
    .run({ name: projectName, provider });
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface SessionState {
  sessionKey: string;
  activeProject: string | null;
  activeModel: string;
  /** Effort level for activeModel — null lets the CLI decide. */
  activeEffort: string | null;
  /** Request the CLI's fast / priority tier for activeModel. */
  activeFast: boolean;
}

/** The (model, effort, fast) triple a session runs with. */
export function sessionSelection(session: SessionState): ModelSelection {
  return { model: session.activeModel, effort: session.activeEffort, fast: session.activeFast };
}

/** Bridge-wide default model selection (config.json). */
export function getDefaultActiveModel(): string {
  return getConfig().settings.defaultActiveModel ?? 'auto';
}

export function getDefaultSelection(): ModelSelection {
  const { settings } = getConfig();
  return {
    model: settings.defaultActiveModel ?? 'auto',
    effort: settings.defaultActiveEffort ?? null,
    fast: settings.defaultActiveFast ?? false,
  };
}

/** Persist the default selection for future sessions (config.json). */
export function persistDefaultSelection(selection: ModelSelection): void {
  const cfg = readConfigFile();
  cfg.settings.defaultActiveModel = selection.model;
  cfg.settings.defaultActiveEffort = selection.effort;
  cfg.settings.defaultActiveFast = selection.fast;
  writeConfigFile(cfg);
}

/** Update the selection on every stored session connection. */
export function setSelectionForAllSessions(selection: ModelSelection): number {
  const result = getDb()
    .prepare(
      `UPDATE session_state
          SET active_model = @model, active_effort = @effort, active_fast = @fast,
              updated_at = datetime('now')`,
    )
    .run({ model: selection.model, effort: selection.effort, fast: selection.fast ? 1 : 0 });
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
    .get(sessionKey) as
    | {
        session_key: string;
        active_project: string | null;
        active_model: string;
        active_effort: string | null;
        active_fast: number;
      }
    | undefined;

  if (!row) {
    const def = getDefaultSelection();
    db.prepare(
      `INSERT INTO session_state (session_key, active_model, active_effort, active_fast)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(sessionKey, def.model, def.effort, def.fast ? 1 : 0);
    return {
      sessionKey,
      activeProject: null,
      activeModel: def.model,
      activeEffort: def.effort,
      activeFast: def.fast,
    };
  }

  return {
    sessionKey: row.session_key,
    activeProject: row.active_project,
    activeModel: row.active_model,
    activeEffort: row.active_effort ?? null,
    activeFast: row.active_fast === 1,
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

/** Update the active model selection for a session. */
export function setActiveSelection(sessionKey: string, selection: ModelSelection): void {
  getDb()
    .prepare(
      `INSERT INTO session_state (session_key, active_model, active_effort, active_fast, updated_at)
       VALUES (@sessionKey, @model, @effort, @fast, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET
         active_model  = excluded.active_model,
         active_effort = excluded.active_effort,
         active_fast   = excluded.active_fast,
         updated_at    = excluded.updated_at`,
    )
    .run({ sessionKey, model: selection.model, effort: selection.effort, fast: selection.fast ? 1 : 0 });
}

/** Copy active project/model from one session key to another (e.g. MCP connection bind). */
export function cloneSessionState(fromKey: string, toKey: string): void {
  const from = getSessionState(fromKey);
  if (from.activeProject) {
    setActiveProject(toKey, from.activeProject);
  }
  if (from.activeModel) {
    setActiveSelection(toKey, sessionSelection(from));
  }
}
