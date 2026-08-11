# 07 — Data Model & Deployment

## State store: SQLite (`better-sqlite3`)

Chosen over a JSON file because we want history, an audit trail, and safe
concurrent reads/writes. Synchronous API keeps the executor code simple; it's a
single-user home service so write contention is a non-issue.

### Schema (initial migration)

```sql
-- Allowlisted projects. The ONLY source of workspace paths.
CREATE TABLE project (
  name        TEXT PRIMARY KEY,         -- canonical voice-friendly id, e.g. "budget"
  path        TEXT NOT NULL,            -- absolute workspace path (trusted)
  aliases     TEXT NOT NULL DEFAULT '[]', -- JSON array of spoken variants
  description TEXT,                     -- short, for the model + spoken readback
  resume_id   TEXT,                     -- current cursor-agent session id
  model       TEXT,                     -- optional per-project model override (overrides session active_model)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sticky per-session state (single-user, but keyed for future multi-user).
CREATE TABLE session_state (
  session_key    TEXT PRIMARY KEY,      -- WS/connection or user key
  active_project TEXT REFERENCES project(name),
  active_model   TEXT NOT NULL DEFAULT 'auto', -- model id; 'auto' = cursor default
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cached model list from cursor-agent models (avoids running the CLI on every request).
CREATE TABLE model_cache (
  id            INTEGER PRIMARY KEY CHECK (id = 1), -- single-row cache
  fetched_at    TEXT NOT NULL,
  models_json   TEXT NOT NULL          -- JSON array of {id, displayName}
);

-- One row per cursor_submit invocation.
CREATE TABLE job (
  id           TEXT PRIMARY KEY,        -- uuid
  project      TEXT NOT NULL REFERENCES project(name),
  prompt       TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'agent',
  status       TEXT NOT NULL,           -- running|done|error|stopped
  pid          INTEGER,
  session_id   TEXT,                    -- cursor-agent session for this run
  checkpoint   TEXT,                    -- git HEAD before the job (for revert)
  summary      TEXT,
  diffstat     TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

-- Streaming progress events (for "still working…" narration + debugging).
CREATE TABLE job_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL REFERENCES job(id),
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  kind      TEXT NOT NULL,              -- tool_start|tool_done|assistant|result|error
  payload   TEXT                        -- JSON
);

-- Security audit: every tool call crossing the boundary.
CREATE TABLE audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  tool      TEXT NOT NULL,
  project   TEXT,
  args_hash TEXT,                       -- hash, not raw (avoid sensitive logs)
  result    TEXT,                       -- ok|rejected|error
  reason    TEXT
);
```

## Configuration model — two files on the host

Configuration lives entirely on the **hosting computer** and is split by
sensitivity, so secrets and settings never mix:

| File | Holds | Committed? | Edited by |
| --- | --- | --- | --- |
| **`.env`** | **Secrets/keys only** — provider API key, app token | **Never** (`.gitignore`; perms `600`) | Owner, via SSH/iSH |
| **`config.json`** | **Settings + the project directory registry** (non-secret) | Example committed (`config.example.json`); real one git-ignored if it contains private paths | Owner, via SSH/iSH (manual registration) |

Rationale: keys rotate independently and must stay out of version control; the
config file is the operator's control surface (settings + which directories
AgentVoice may touch). Both are loaded and **schema-validated (zod)** at bridge
startup; invalid config fails fast with a clear error.

> The DB (`state.db`) is **runtime state** (sessions, jobs, audit, resume ids),
> not configuration. `config.json` is the source of truth for projects; on
> startup the bridge **reconciles** the registry table from `config.json`
> (adds/updates/disables entries) while preserving per-project `resume_id`.

### Project registry (manual registration)

- Projects are **registered manually** by the owner editing `config.json` (the
  `projects` array) over SSH/iSH — **never created/edited via voice or by dad**.
  This is a security boundary: the set of allowlisted directories is operator-
  controlled.
- The registry is the **only** place workspace paths come from. Every tool that
  takes a `project` resolves `name → path`; a missing/disabled project is
  rejected at the API. The resolved `path` is what gets passed to
  `cursor-agent --workspace` (see `05`).
- Both consumers read the same registry:
  - **Web app dropdown** — dad manually selects a project (see `06`).
  - **Voice agent** — `cursor_list_projects` lets the model view/search/select,
    plus `cursor_set_project` to choose (see `05`/`06`).
- Voice-friendly names matter (dad says them): short, distinct, low phonetic
  collision (helps STT). Document the naming convention with the user.
- Each entry carries `aliases[]` (spoken variants), a short `description`, and
  `enabled`. The bridge injects `name + aliases + description` into the realtime
  session so the model can map natural speech to a canonical name; the server
  still re-resolves + validates every value (see `05` → Project selection).

### Run mode (`test` vs `serve`)

`settings.runMode` selects which row in `settings.runModes` controls ports and URLs:

| Mode | Purpose | Backend | Web app |
| --- | --- | --- | --- |
| **`test`** | Local development | `backendPort` (e.g. 8000) — bridge only | **`webPort` (4200)** — open in browser; proxies `/api` + `/ws` to bridge |
| **`serve`** | Production / Tailscale | `127.0.0.1:8787` (default) | Same origin — bridge serves `web/dist` |

```json
"runMode": "test",
"runModes": {
  "test": { "backendPort": 8000, "webPort": 4200 },
  "serve": {
    "backendPort": 8787,
    "publicBaseUrl": "https://your-machine.tailnet-name.ts.net"
  }
}
```

**Dev routing** (`npm run dev`):

```
Browser → http://localhost:4200/     (ng serve — entry point)
  ├─ /api/*              → proxied to bridge :backendPort
  ├─ /ws/*               → proxied to bridge :backendPort
  └─ /*                  → Angular (HMR)

Bridge → http://127.0.0.1:<backendPort>   (API + WebSockets only in test mode)
```

- **`test`:** run `npm run dev`. Open **`http://localhost:4200`**. Leave Bridge URL blank in the PWA.
  The dev bridge binds `runModes.test.backendPort` (default **`5089`**) on `127.0.0.1`.
- **`serve`:** `npm run build && npm start`. Open `publicBaseUrl` (or `127.0.0.1:8787` locally). Set `runMode` to `"serve"` before deploying.

**Dev port is decoupled from the host.** `npm run dev` sets `NODE_ENV=development`,
which forces the **`test`** run profile *regardless* of `config.json` → `settings.runMode`.
So the dev server binds `runModes.test.backendPort` (default `5089`, loopback) while the
production host service runs in `serve` mode on `8787` (`0.0.0.0` for Tailscale). They use
different ports and can run **side by side** — no `EADDRINUSE` collision.

**Host service control** (independent of `npm run dev`):

- `npm run stop` — stops the `agentvoice` systemd service **and** its rebuild watcher
  (`agentvoice-watch.path`), then frees the host port (`8787`). Windows: `scripts\stop.ps1`.
- `npm run start:service` — starts the host service back up, health-checked. Windows: `scripts\start.ps1`.

**Serve** (manual self-hosting maintenance): Config tab → **Serve** — force pull &
rebase onto `main` (or `settings.serve.branch`), update service (rebase → deps →
build → restart), and read `journalctl` service logs. No scheduled auto-update.
See [`21-serve-self-hosting.md`](./21-serve-self-hosting.md).

`GET /healthz` returns `runMode`, `backendUrl`, `webUrl`, and `useDevWebServer` for quick sanity checks.

### Example `config.json`

```json
{
  "settings": {
    "voiceProvider": "openai",
    "realtimeModel": "gpt-realtime",
    "defaultMode": "agent",
    "maxConcurrentJobs": 1,
    "jobTimeoutMs": 600000,
    "planFirst": false,
    "preRunFlags": ["--force", "--trust"],
    "modelCacheTtlMs": 3600000,
    "narratorEnabled": true,
    "narratorCadenceMs": 15000,
    "narratorMaxBufferEvents": 50,
    "logLevel": "info"
  },
  "projects": [
    {
      "name": "cursorvoice",
      "path": "/home/eva/Projects/SideProjects/CursorVoice",
      "aliases": ["cursor voice", "the voice project"],
      "description": "This project — the voice bridge",
      "enabled": true
    },
    {
      "name": "budget",
      "path": "/home/projects/budget-app",
      "aliases": ["budget app", "the finance tracker", "money app"],
      "description": "Personal finance tracker (web)",
      "enabled": true
    }
  ]
}
```

Settings here are **non-secret** operational toggles; secrets stay in `.env`. If
a setting must override per-environment, env vars take precedence over
`config.json` (documented precedence: `.env` > `config.json` > built-in default).

### Recovery semantics

- On bridge startup: any `job` left `running` (process died with old bridge) is
  marked `error`. Orphan PIDs are not trusted across restarts.
- `resume_id` persists on `project`, so sessions survive restarts.
- **Manual recovery:** `cursor-agent ls --workspace <that project's path>` —
  sessions are **workspace-scoped**, not global. Listing from cwd (or the wrong
  `--workspace`) will not show another project's sessions. Always pair
  `--resume <id>` with the **same** `--workspace` the session was created under.

## Deployment

### Topology

```
[ iPhone ] ──Tailscale (WireGuard)── [ home machine ]
                                       ├─ tailscale serve (TLS termination)
                                       └─ bridge (systemd) :PORT (localhost)
                                            └─ cursor-agent (child process)
```

### Tailscale (private HTTPS for mic)

```bash
# one-time
sudo tailscale up
# enable HTTPS certs in the admin console (DNS → HTTPS Certificates)
# expose the bridge privately over HTTPS (tailnet-only, NOT funnel)
sudo tailscale serve --bg 443 http://127.0.0.1:PORT
# result: https://<machine>.<tailnet>.ts.net
```

- Bridge binds **127.0.0.1** only; Tailscale handles TLS + proxy. No app-side
  cert handling.
- **Do not** use `tailscale funnel` (public) for the default design.

### systemd unit (sketch)

```ini
[Unit]
Description=AgentVoice Bridge
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=agentvoice            # dedicated least-privileged user
WorkingDirectory=/opt/agentvoice
EnvironmentFile=/opt/agentvoice/.env
ExecStart=/usr/bin/node /opt/agentvoice/dist/index.js
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/agentvoice /path/to/allowlisted/projects
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

> Adjust `ReadWritePaths` to exactly the project workspaces the agent may touch —
> another layer of the "bounded blast radius" model.

### Build

- TypeScript compiled/bundled with `tsup`/`esbuild` to `dist/index.js`.
- PWA built by Vite to `web/dist`, served statically by Fastify.
- Pin `cursor-agent` version; record it in the health endpoint.

### Secrets (`.env.example`) — keys only

`.env` holds **secrets and machine-specific bootstrap paths only**. Operational
settings live in `config.json` (above). Keep this file `600` and out of git.

```ini
# Secrets
APP_TOKEN=                      # high-entropy shared secret (single user)
OPENAI_API_KEY=                 # speech provider key (separate from Cursor)
# GEMINI_API_KEY=               # if VOICE_PROVIDER=gemini

# Bootstrap paths / bind (non-secret but machine-specific)
PORT=8787
CONFIG_PATH=/opt/agentvoice/config/config.json
DB_PATH=/opt/agentvoice/data/state.db
```

> Precedence: `.env` > `config.json` > built-in defaults. Anything non-secret
> (provider choice, models, timeouts, project list) belongs in `config.json` so
> the owner has one obvious place to manage behavior; `.env` is just keys + where
> to find the config/db.

### cursor-agent permission files (auto-run guardrails)

Because the voice flow runs `cursor-agent` with `--force --trust` (non-blocking;
see `05`), guardrails come from CLI permission **deny** lists, which `--force`
still honors. Provision these at deploy time for the service user:

- **Global:** `~/.cursor/cli-config.json` (the dedicated service user's home).
- **Per project (optional):** `<workspace>/.cursor/cli.json` (only `permissions`
  allowed at project level).

```json
{
  "version": 1,
  "permissions": {
    "allow": [],
    "deny": [
      "Shell(rm)", "Shell(sudo)", "Shell(git:push*)",
      "Read(.env*)", "Write(**/*.key)", "Write(**/*.pem)"
    ]
  }
}
```

Ship a `cli-config.example.json` in the repo and have the installer/systemd setup
place it. Treat the deny list as security config (see `03`). The voice model and
dad cannot modify these files.

### Operations

- **Health endpoint** `/healthz`: bridge up, db ok, config loaded + N projects,
  `cursor-agent --version`, tailscale reachable.
- **Logs**: structured JSON to stdout → journald; rotate via journald limits.
- **Monitoring/fallback**: SSH/iSH for setup, logs, manual project registration
  (`config.json`), and manual `cursor-agent` runs (out of the voice flow).
- **Backups**: the SQLite db + `config.json`.
