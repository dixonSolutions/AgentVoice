# 35 — The `agentvoice` CLI

`agentvoice` is the management surface for a self-hosted bridge. It boots the
bridge, manages its systemd unit, reports what is installed and whether it is
healthy, rotates the pairing token, and updates the install the way that
install was actually made.

It ships in the npm package (`package.json#bin`) and works the same from a
clone via `npm run cli -- <command>`.

```
agentvoice [command] [options]
```

`run` is the default. Bare `agentvoice` boots the bridge exactly as it always
has — that behaviour is a published contract and nothing may take it back.

## Commands

| Command | What it does |
| --- | --- |
| `run` | Boot the bridge in the foreground. Seeds the home on first run. |
| `start` / `stop` / `restart` | Manage the `agentvoice.service` systemd unit. |
| `logs [-n N] [-f]` | `journalctl` for the unit. `-f` follows. |
| `status [--json]` | Install, version, service, port, health, token — one screen. |
| `doctor [--json]` | Check Node, the native binding, config, data dir, agent CLI, port. |
| `update [--stash] [--dry-run] [--branch <name>]` | Update this install. |
| `token [--new]` | Print the pairing token, or mint a fresh one. |
| `version`, `--version` | Package version, plus branch and commit in a clone. |
| `help`, `--help` | Usage screen. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Failure. Also what `status` returns when the bridge is not answering, so `agentvoice status >/dev/null` is a liveness probe. |
| `2` | Usage error — unknown command, unknown option, bad value. Prints usage. |

## The bridge home

Every command acts on a **home** — the directory holding `config.json`, `.env`
and `data/state.db`. It is resolved in this order:

1. `$AGENTVOICE_HOME`, if set.
2. The current directory, if it already holds a `config.json` or `data/state.db`.
3. The install root, if *that* looks like a home. A git clone is its own home,
   so `agentvoice status` works from anywhere. An npm install never matches —
   nothing seeds a `config.json` under `node_modules`.
4. `~/.agentvoice`.

`run` seeds a new home: `config.json` from the packaged `config.example.json`
(forced to `runMode: "serve"`, because an installed package has no Angular dev
server to proxy to), a random `APP_TOKEN` in `.env` at mode `0600`, and links to
the packaged `web/dist` and `package.json`.

## `status`

```
  AgentVoice

  install  git  /home/you/AgentVoice
           running from a git clone (.git found at the package root)
  home     /home/you/AgentVoice
  version  0.1.2  main @ 4f19ac1
           vs origin/main · 3 behind (as of the last fetch)
           HEAD: Release 0.1.2 with the composer fix
  config   ok 17 projects
           /home/you/AgentVoice/config.json
  service  active (running)
           agentvoice.service (user unit, enabled)
           since Fri 2026-09-12 18:04:11 CEST · pid 31184
  bridge   healthy  http://127.0.0.1:5089
           port 5089 from config.json settings.runModes.serve.backendPort
  healthz  db ok · 17 projects · agent CLI claude-code 2.1.4
           runMode serve · open https://host.tail-scale.ts.net
  token    configured (.env)
  update   agentvoice update → bash scripts/update.sh
```

Notes on what it is telling you:

- **version** — a clone reports branch, short commit and drift from its
  upstream. That drift is **as of the last `git fetch`**: `status` never touches
  the network for git, because a status command that quietly does I/O over the
  wire is a surprise. An npm install instead asks the registry what `latest` is,
  with a 3-second timeout, and degrades to one honest line if that fails.
- **bridge** — the port comes from `settings.runMode` and the matching entry in
  `settings.runModes`, mirroring `src/runMode.ts`. If that port is silent the
  CLI also probes the other profile's port, because `npm run dev` forces the
  test profile via `NODE_ENV` and the CLI cannot see the environment the service
  was started with. The row always says which port it used and where it came
  from.
- **token** — reported as configured or not, never printed. `token` is the one
  command allowed to show it.

`--json` prints the same report as a single JSON document on stdout; every
diagnostic goes to stderr, so it stays parseable.

## `doctor`

Seven checks, each with a remedy attached:

| Check | Fails when |
| --- | --- |
| `node` | Older than Node 20. |
| `sqlite` | The `better-sqlite3` native binding will not load. |
| `config.json` | Missing or unparseable. Warns when it registers no projects. |
| `data dir` | The directory holding `DB_PATH` is not writable (tested by writing, not by `access()`). |
| `APP_TOKEN` | Absent (warn) or shorter than the 16 characters the bridge's own schema demands (fail). |
| `agent CLI` | The CLI named by `settings.agentClient` cannot be found. |
| `port` | The configured port is held by something that is not AgentVoice. |

Warnings do not fail the run — "no `APP_TOKEN` yet" is a normal state five
seconds after install. Any `fail` exits 1.

The agent-CLI check covers all four providers (Cursor, Codex, Claude Code,
Codewhale). It resolves the binary the same way the providers do — `<CLI>_PATH`
override, then the known install directories, then `PATH` — but it does **not**
import the provider registry: that would drag the whole executor stack,
`@aws-sdk` included, into a management CLI that is otherwise 48 KB. The
authoritative answer still comes from the bridge, which reports the resolved CLI
and its version on `/healthz`; `doctor`'s copy exists so it can say something
useful while the bridge is down.

## `update`

Dispatches on `detectInstallMode()` (see `src/serve/installMode.ts`), because a
clone and an npm install have nothing in common here and guessing wrong is
destructive both ways — `npm i -g` inside a clone installs a *second* copy that
shadows the one you are developing, and a rebase is meaningless under
`node_modules`.

- **git** → `bash scripts/update.sh`, the single update path the Serve page also
  uses (see [`21-serve-self-hosting.md`](./21-serve-self-hosting.md)). `--stash`,
  `--dry-run`, `--force`, `--no-restart` and `--branch <name>` are forwarded
  verbatim; anything after `--` is forwarded too.
- **npm** → `npm install -g agentvoice@latest`, dropping `-g` when the install
  is a local dependency rather than a global one.
- **unknown** → refuses, says why, and explains how to reinstall into a mode
  that *can* be maintained.

## `token`

The token goes to stdout on its own line; everything else goes to stderr, so
`agentvoice token | pbcopy` does the obvious thing.

`token --new` rewrites the `APP_TOKEN` line of `<home>/.env` in place at mode
`0600`, preserving every other line — `.env` also holds AWS keys and provider
credentials, and losing those to a token rotation would be an unpleasant
surprise. Every paired client is locked out afterwards and has to re-pair, and
the bridge needs a restart to load the new value. If `APP_TOKEN` is also set in
the environment it wins over the file, and the command says so.

## The systemd unit

`start`, `stop`, `restart` and `logs` all resolve the unit the same way
`scripts/update.sh` and `src/serve/index.ts` do, and the order matters:

1. `systemctl --user cat agentvoice.service` — the user unit
   `scripts/install-systemd.sh` writes, which is what most installs have.
2. `systemctl cat agentvoice.service` — a system unit.
3. Neither: say so, and point at the installer or at `agentvoice run`.

A system unit needs root, so it is driven through `sudo -n` — non-interactive on
purpose. A CLI that silently blocks on a hidden password prompt is worse than
one that says "passwordless sudo required".

`agentvoice restart` is deliberately *not* `scripts/restart.sh`: that script
rebuilds first, which is an update concern. This bounces the service and nothing
else, which is what you want after editing `config.json`.

## Structure

```
bin/agentvoice.mjs     shim: import dist/cli.js, call main()
src/cli/index.ts       argv dispatch, usage screen, exit codes
src/cli/silence.ts     silences the bridge's pino logger (imported first)
src/cli/args.ts        flag parser
src/cli/out.ts         colour, aligned key/value rendering
src/cli/exec.ts        capture (probes) vs passthrough (long jobs)
src/cli/home.ts        home resolution, seeding, .env and config.json reading
src/cli/service.ts     systemd unit detection and control
src/cli/bridge.ts      port resolution and the /healthz probe
src/cli/versions.ts    package version, git drift, registry latest
src/cli/commands/*.ts  one file per command group
```

The logic is TypeScript under `src/cli/` rather than JavaScript in `bin/` so it
is typechecked with the rest of the bridge and can import what the bridge
already knows. `tsup` builds it to `dist/cli.js` as a second entry with
`splitting: false` — `agentvoice run` loads `dist/cli.js` and then
`dist/index.js` in the same process, and a shared chunk would make them share
module state, so the CLI's silenced logger would silence the bridge's own logs.

`src/cli/silence.ts` has to be the first import in `src/cli/index.ts`. Modules
under `src/` take their child logger at import time, and a child captures
whatever root logger existed at that moment — so silencing from inside `main()`
is already too late, and `detectInstallMode()`'s first call would print a JSON
log line into the middle of `status --json`.

The CLI adds no runtime dependencies.


## `prepare-vosk`

Wake words need Vosk's small English model — about 41 MB of weights. It is **not
in the published tarball**: bundling it would more than double the download for
every install, including the many that never turn wake words on.

```bash
agentvoice prepare-vosk           # fetch it
agentvoice prepare-vosk --force   # fetch it again
```

It lands where this install actually serves static assets from — `web/public/`
in a clone, so it survives the next `ng build`, and `web/dist/` in an installed
package, which has no build step to run. The PWA asks for `/vosk/model.tar.gz`
either way.

Without it, wake words are unavailable and on-screen Speak / Cancel still work,
which is what `touchControls` already falls back to.
