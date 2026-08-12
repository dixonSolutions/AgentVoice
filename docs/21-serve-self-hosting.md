# Serve self-hosting

Serve is the **manual** self-hosting maintenance hub in Config → Serve: force
pull + rebase onto `main` (or a configured branch), install deps, build, restart
the systemd service, and read service logs. There is **no scheduled auto-update**
— unattended git pull/build/restart was removed on purpose.

## Config (`settings.serve` in config.json)

| Key | Default | Description |
|-----|---------|-------------|
| `branch` | `main` (runtime) | Upstream branch for force rebase (`origin/<branch>`) |
| `repoDir` | _(cwd)_ | Optional repository root |

Legacy keys (`enabled`, `intervalMs`, `autoPull`, `autoInstallDeps`, `autoBuild`,
`autoRestart`, `abortOnLocalChanges`) and old `settings.heartbeat` are stripped
on load.

See [config.example.json](../config.example.json).

## Actions

| Action | Behavior |
|--------|----------|
| **Update service** | Fetch + rebase onto `origin/<branch>` → `npm install` if lockfile changed → `npm run build` → restart → health check |
| **Force pull & rebase** | Stash dirty tree if needed, `git fetch` + `git rebase origin/<branch>`, restore stash |
| **Install deps** | `npm install` + `npm rebuild` |
| **Build** | `npm run build` |
| **Restart** | Prefer `agentvoice-watch.path`; else detached `scripts/restart.sh --no-build` |
| **Health check** | GET `/healthz` on configured `PORT` |
| **Service logs** | `journalctl --user -u agentvoice.service` (fixed unit name) |

Each update step writes a row to `serve_event` and an audit entry.

## Admin API (Bearer `APP_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/serve` | Settings + live status (git snapshot, last run) |
| PATCH | `/api/admin/serve` | Update `branch` / `repoDir` |
| POST | `/api/admin/serve/run` | Start full manual update (409 if already running) |
| POST | `/api/admin/serve/action` | Single action: `pull` (rebase), `deps`, `build`, `restart`, `health` |
| GET | `/api/admin/serve/events?limit=` | Recent step log |
| GET | `/api/admin/serve/logs?lines=` | Service journal (max 500 lines) |
| POST | `/api/admin/serve/install` | Spawn `scripts/install-systemd.sh` in background |

Hosting run mode / ports remain at `/api/admin/hosting` and are edited in the Serve hub **Network** tab.

## Health check & version

`GET /healthz` (unauthenticated) returns:

| Field | Meaning |
| --- | --- |
| `status` / `db` / `projects` | Bridge health |
| `cliVersion` | Cursor CLI version (cached) |
| `appVersion` | `package.json` version |
| `gitCommit` | Short git SHA of the running repo |
| `runMode` / URLs | Hosting endpoints |

After **Update service**, hard-refresh the PWA. Confirm deploy via:

1. Config → Connection — muted `v0.1.0 · abc1234` footer
2. Config → Serve → Status — git `currentCommit`
3. `curl https://your-host/healthz` — `appVersion` + `gitCommit` match

## Config tab

Open **Config → Serve**:

- **Status** — idle/running, last run, git snapshot; track branch + repo dir
- **Actions** — Update service; force pull & rebase; deps / build / restart / health; install hosting
- **Network** — hosting provider + run mode / ports / public URL
- **Activity** — service journal + update step log

## Safety

- No background scheduler
- Dirty trees are stashed before rebase and popped after (failed rebase aborts and restores stash when possible)
- Subprocess argv is fixed (`npm`, `bash`, `systemctl`, `journalctl`); only numeric `lines` is accepted for logs
- Failures are logged; the bridge process is not terminated on serve errors
- Only one serve operation at a time (409 if busy)

## Code

- [`src/serve/index.ts`](../src/serve/index.ts) — orchestrator + granular actions + journal logs
- [`src/routes/serve.ts`](../src/routes/serve.ts) — admin routes
- [`src/state/serveEvents.ts`](../src/state/serveEvents.ts) — SQLite step log
