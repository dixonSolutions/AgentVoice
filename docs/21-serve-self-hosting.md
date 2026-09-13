# Serve self-hosting

Serve is the **manual** self-hosting hub in Config → Serve. There is **no
heartbeat** and **no scheduled pull/restart**. Unattended git pull / build /
restart was removed on purpose.

Serve is for:

1. **Update** — [`scripts/update.sh`](../scripts/update.sh), the single update path
2. **Restart the entire service** — detached `scripts/restart.sh` (build + systemd)
3. **Health check** — `GET /healthz` on the configured backend port
4. **Live journalctl logs** — follow `agentvoice.service` (user unit, then system)

## One update script

`scripts/update.sh` is **the** update path. Both Serve buttons run it, and
running it by hand does exactly the same thing — there is no second way to
bring a host up to date.

```bash
bash scripts/update.sh            # rebase & update (clean tree required)
bash scripts/update.sh --stash    # stash, rebase & update, then pop the stash
bash scripts/update.sh --dry-run  # report only; changes nothing
```

In order, it:

| # | Step id | What it does |
|---|---------|--------------|
| 1 | `preflight` | Repo sanity (git, origin, package.json, no rebase in progress); resolves the Node/npm the **service** runs, so the build matches the runtime |
| 2 | `git_fetch` | `git fetch --prune origin`, then refreshes `origin/HEAD` |
| 3 | `git_target` | Resolves the track branch → `origin/<branch>`; reports HEAD, upstream, ahead/behind |
| 4 | `git_scan` | Local changes, incoming changes, and the **overlap** of the two |
| 5 | `git_stash` | `--stash` only, and only when the tree is dirty (`--include-untracked`) |
| 6 | `git_rebase` | `git rebase origin/<branch>`; on failure `--abort`, restore the stash, exit 1 |
| 7 | `git_stash_pop` | Pops the stash; a conflicting pop keeps the stash and warns rather than losing it |
| 8 | `deps` | `npm ci`, falling back to `npm install --legacy-peer-deps`, then `npm rebuild` |
| 9 | `build` | `npm run build` (backend + PWA), then asserts `dist/index.js` exists |
| 10 | `restart` | `systemctl restart agentvoice.service` — **user unit if one exists, else the system unit** (`sudo -n` when not root) |
| 11 | `health` | `GET /healthz` on `settings.runModes.serve.backendPort`, retried for ~20s |

Options:

| Flag | Effect |
|------|--------|
| `--stash` | Stash local changes before the rebase and pop them after. Without it a dirty tree is a **hard failure** — that is what the two buttons are. |
| `--branch <name>` | Rebase onto `origin/<name>`. Default: `settings.serve.branch`, else origin's default branch, else `main`. |
| `--repo <dir>` | Repository root. Default: the parent of the script. |
| `--dry-run` | Report what would happen. Fetches with `--dry-run`, writes nothing, builds nothing, restarts nothing. |
| `--force` | Do deps/build/restart even when already at the upstream tip. |
| `--no-restart` | Update and build, leave the service running the old code. |
| `--run-id <id>` / `--log-file <path>` | Correlation id and NDJSON log path. The bridge passes both. |

**Idempotent.** With no new commits and a `dist/index.js` already present it
stops at `git_rebase: skip` and does nothing else. `--force` overrides that.

**Fails loudly.** Every failure writes an `error` step with the git or npm
message and exits 1. Nothing is half-applied: a failed rebase is aborted and the
stash is restored before the script gives up.

### The step log

Every step emits one NDJSON line to `data/serve-update.jsonl` and one coloured
line to stdout:

```json
{"runId":"…","ts":"2026-…","step":"git_rebase","status":"ok","detail":"rebased onto origin/main (2c5d4f1f → 9ab3c210)"}
```

`status` is `ok` | `skip` | `warn` | `error`. The bridge drains that file into
the `serve_event` table, which is what Config → Serve → Logs renders.

The cursor into the file is simply *how many rows already exist for this run id*
— the script appends in order and the bridge inserts in order. That is what lets
the log survive the restart the update itself performs: `startServe()` drains
the same file on boot and picks the run back up, so the step log is complete
even though the process that started it was killed halfway through.

## Config (`settings.serve` in config.json)

| Key | Default | Description |
|-----|---------|-------------|
| `branch` | origin default, else `main` | Upstream branch to rebase onto (`origin/<branch>`). Saved when you Save or Update. Leave unset/blank to follow origin's default branch. |
| `repoDir` | _(cwd)_ | Optional repository root |

Legacy keys (`enabled`, `intervalMs`, `autoPull`, `autoInstallDeps`, `autoBuild`,
`autoRestart`, `abortOnLocalChanges`) and old `settings.heartbeat` are stripped
on load.

See [config.example.json](../config.example.json).

## Branch resolution

Update always targets `origin/<trackBranch>`. Origin is assumed to already exist
on the host. `trackBranch` is:

1. `settings.serve.branch` if you saved one (remembered across restarts)
2. Else origin's advertised default (`git symbolic-ref refs/remotes/origin/HEAD`)
3. Else `main`

## Actions

| Action | Behavior |
|--------|----------|
| **Rebase & update** (`update`) | Saves the branch field, then runs `scripts/update.sh`. Refused up front if the working tree is dirty — `git rebase` would refuse anyway, and the refusal names the files. |
| **Stash, rebase & update** (`stash-update`) | The same script with `--stash`. Local changes are stashed (including untracked), the rebase runs, the stash is popped. |
| **Restart service** (`restart`) | Spawns detached `scripts/restart.sh` (deps + build + systemd restart + health). Touches no git state. |
| **Health check** (`health`) | `GET /healthz` on the configured backend port |
| **Service logs** | Live `journalctl -f -u agentvoice.service` (SSE). Snapshot `GET` is the fallback. |

The old `pull` action is gone. It only rebased — it never installed, built or
restarted, so "pulled successfully" routinely meant "still running the old
code". `update` is what replaced it.

Each action writes rows to `serve_event` and an audit entry.

## Conflicting changes

The status snapshot reports two different things and the **intersection** of
them, because that intersection is the only one that decides which button to
press:

| Field | Source |
|-------|--------|
| `localChanges` | `git status --porcelain -uall` — modified, staged, renamed and untracked |
| `incomingCount` | How many files `git diff --name-only HEAD..origin/<branch>` lists |
| `conflictFiles` | `localChanges` ∩ those incoming files |

`conflictFiles` is what the Serve page lists under the git line. Non-empty means
a plain rebase would fight over those exact paths; use the stash button.

Both lists are capped at 100 entries in the API payload, so `localChangeCount`
and `conflictCount` carry the uncapped totals — the UI counts from those, never
from `array.length`.

## Admin API (Bearer `APP_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/serve?fetch=1` | Settings + live status. `fetch=1` fetches origin first, which is the only way ahead/behind and `conflictFiles` are current. |
| PATCH | `/api/admin/serve` | Update `branch` / `repoDir` (empty string clears; blank branch follows origin default) |
| POST | `/api/admin/serve/action` | `update`, `stash-update`, `restart`, `health` |
| GET | `/api/admin/serve/events?limit=` | Recent step log |
| GET | `/api/admin/serve/logs?lines=` | Journal snapshot (max 500 lines) |
| GET | `/api/admin/serve/logs/stream?lines=` | Live `journalctl -f` (SSE) |

`status.git` carries `branch`, `trackBranch`, `defaultBranch`, `currentCommit`,
`shortCommit`, `commitSubject`, `commitDate`, `upstreamCommit`, `ahead`,
`behind`, `dirty`, `localChanges`, `localChangeCount`, `incomingCount`,
`conflictFiles`, `conflictCount` and `fetchedAt`. `status.updateRunId` is set
while an update is in flight.

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

After an update, hard-refresh the PWA. Confirm the deploy via:

1. Config → Connection — muted `v0.1.0 · abc1234` footer
2. Config → Serve → Status — git `shortCommit` + commit subject
3. `curl https://your-host/healthz` — `appVersion` + `gitCommit` match

## Config tab

Open **Config → Serve**:

- **Status** — idle/running, last run, git snapshot (HEAD branch, commit id and
  subject, track branch, origin default, ahead/behind, local changes and the
  conflicting-files list); track branch + repo dir; the two update buttons;
  restart / health
- **Network** — hosting provider + run mode / ports / public URL
- **Logs** — live service journal + the update step log (polled every 2s while a
  run is in flight, straight through the restart)

The **Stash, rebase & update** button is secondary until the working tree is
dirty, at which point it becomes the emphasised one — and **Rebase & update**
disables itself, because it is the one that cannot succeed.

## Safety

- No background scheduler / heartbeat
- `update` refuses a dirty tree outright rather than half-rebasing
- `--stash` restores the stash after a failed rebase; an unpoppable stash is
  kept and reported, never dropped
- Subprocess argv is fixed (`bash`, `git`, `journalctl`); the only interpolated
  values are the resolved repo dir, the track branch and the run id
- Failures are logged; the bridge process is not terminated on serve errors
- Only one serve operation at a time (409 if busy) — an update holds the lock
  until its script writes `finish`

## Why the update script restarts, and why it survives doing so

Both `update.sh` and `scripts/restart.sh` stop the bridge itself. A plain
detached child stays in the service cgroup and is killed the instant the unit
stops, which took the bridge down permanently. They are spawned via
`systemd-run --user --scope --collect` (plain spawn on non-systemd hosts) so the
script outlives the process that launched it.

`update.sh` detects which unit actually exists — `systemctl --user cat
agentvoice.service` first, then the system unit via `sudo -n` — instead of
assuming a user unit. A host with neither gets a clear error pointing at
`scripts/install-systemd.sh`, not a silent no-op.

Restart used to report `skipped` whenever `agentvoice-watch.path` was active, on
the assumption that the unit would pick up the new `dist/index.js`. When that
trigger silently failed, the old process kept serving while the UI reported
success. Restart is now unconditional; a redundant restart is harmless.

Fresh builds are also served correctly without a restart: `@fastify/static` runs
with `wildcard: true`, so files are resolved per request instead of from a
boot-time listing (which used to make new asset hashes fall through to the SPA
handler and return `index.html` with a `text/html` type for `.js` and `.css`).

## Code

- [`scripts/update.sh`](../scripts/update.sh) — the single update path
- [`src/serve/index.ts`](../src/serve/index.ts) — git snapshot + conflict set, update spawn, step-log ingest, restart, health, journal follow
- [`src/routes/serve.ts`](../src/routes/serve.ts) — admin routes + live log SSE
- [`src/state/serveEvents.ts`](../src/state/serveEvents.ts) — SQLite step log
