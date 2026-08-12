# Serve self-hosting

Serve is the **manual** self-hosting hub in Config → Serve. There is **no
heartbeat** and **no scheduled pull/restart**. Unattended git pull / build /
restart was removed on purpose.

Serve is for:

1. **Health check** — `GET /healthz` on the configured `PORT`
2. **Live journalctl logs** — follow `agentvoice.service` (user unit, then system)
3. **Restart the entire service** — detached `scripts/restart.sh` (build + systemd)
4. **Rebase onto origin** — fetch + rebase onto `origin/<branch>` (origin is trusted)

## Config (`settings.serve` in config.json)

| Key | Default | Description |
|-----|---------|-------------|
| `branch` | origin default, else `main` | Upstream branch for rebase (`origin/<branch>`). Saved when you Save or Rebase. Leave unset/blank to follow origin's default branch. |
| `repoDir` | _(cwd)_ | Optional repository root |

Legacy keys (`enabled`, `intervalMs`, `autoPull`, `autoInstallDeps`, `autoBuild`,
`autoRestart`, `abortOnLocalChanges`) and old `settings.heartbeat` are stripped
on load.

See [config.example.json](../config.example.json).

## Branch resolution

Rebase always targets `origin/<trackBranch>`. Origin is assumed to already exist
on the host. `trackBranch` is:

1. `settings.serve.branch` if you saved one (remembered across restarts)
2. Else origin's advertised default (`git symbolic-ref refs/remotes/origin/HEAD`)
3. Else `main`

## Actions

| Action | Behavior |
|--------|----------|
| **Rebase onto origin/&lt;branch&gt;** | Saves the current branch field, `git fetch origin`, rebases onto `origin/<trackBranch>` with origin winning overlapping hunks (`-X ours` — ours is upstream during rebase). Dirty trees are stashed and restored. |
| **Restart service** | Always spawns detached `scripts/restart.sh` (full script: deps + build + systemd restart + health) |
| **Health check** | GET `/healthz` on configured `PORT` |
| **Service logs** | Live `journalctl -f -u agentvoice.service` (SSE). Snapshot `GET` is the fallback. |

Each action writes a row to `serve_event` and an audit entry.

## Admin API (Bearer `APP_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/serve` | Settings + live status (git snapshot, last run) |
| PATCH | `/api/admin/serve` | Update `branch` / `repoDir` (empty string clears; blank branch follows origin default) |
| POST | `/api/admin/serve/action` | `pull` (rebase), `restart`, `health` |
| GET | `/api/admin/serve/events?limit=` | Recent step log |
| GET | `/api/admin/serve/logs?lines=` | Journal snapshot (max 500 lines) |
| GET | `/api/admin/serve/logs/stream?lines=` | Live `journalctl -f` (SSE) |

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

After **Restart service**, hard-refresh the PWA. Confirm deploy via:

1. Config → Connection — muted `v0.1.0 · abc1234` footer
2. Config → Serve → Status — git `currentCommit`
3. `curl https://your-host/healthz` — `appVersion` + `gitCommit` match

## Config tab

Open **Config → Serve**:

- **Status** — idle/running, last run, git snapshot (HEAD, track branch, origin default); track branch + repo dir; rebase / restart / health
- **Network** — hosting provider + run mode / ports / public URL
- **Logs** — live service journal + action step log

## Safety

- No background scheduler / heartbeat
- Dirty trees are stashed before rebase and popped after (failed rebase aborts and restores stash when possible)
- Subprocess argv is fixed (`git`, `bash`, `journalctl`); only numeric `lines` is accepted for logs
- Failures are logged; the bridge process is not terminated on serve errors
- Only one serve operation at a time (409 if busy)

## Why restart never defers to the watch unit

Restart used to report `skipped` whenever `agentvoice-watch.path` was active, on
the assumption that the unit would pick up the new `dist/index.js`. When that
trigger silently failed, the old process kept serving while the UI reported
success. Restart is now unconditional; a redundant restart is harmless.

Both `restart` and `scripts/restart.sh` stop the bridge itself. A plain detached
child stays in the service cgroup and is killed the instant the unit stops,
which took the bridge down permanently. They now run via
`systemd-run --user --scope --collect` (plain spawn on non-systemd hosts) so the
script outlives the process that launched it.

Fresh builds are also served correctly without a restart: `@fastify/static` runs
with `wildcard: true`, so files are resolved per request instead of from a
boot-time listing (which used to make new asset hashes fall through to the SPA
handler and return `index.html` with a `text/html` type for `.js` and `.css`).

## Code

- [`src/serve/index.ts`](../src/serve/index.ts) — rebase, restart script, health, journal follow
- [`src/routes/serve.ts`](../src/routes/serve.ts) — admin routes + live log SSE
- [`src/state/serveEvents.ts`](../src/state/serveEvents.ts) — SQLite step log
