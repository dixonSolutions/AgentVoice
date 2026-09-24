# 35 — The `agentvoice` CLI

`agentvoice` is the management surface for a self-hosted bridge. It boots the
bridge, manages its background service (systemd, launchd, or a Windows service), reports what is installed and whether it is
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
| `start` / `stop` / `restart` | Manage the background service — `agentvoice.service` (systemd), `com.agentvoice.bridge` (launchd) or `AgentVoice` (Windows). |
| `service install [--now] [--force] [--dry-run]` | Install that service for this install — see [The service](#the-service). |
| `logs [-n N] [-f]` | `journalctl` for a systemd unit. `-f` follows. Everywhere else (launchd, Windows, no service), the bridge's own session log. |
| `logs --list` / `--files` / `--transcripts` / `--cat <file\|latest>` | The session log files and voice transcripts under `<home>/logs/` — list, tail (`-f` follows across rollovers), or print (`.gz` included). `--profile test` for the dev folder. See docs/42. |
| `pipe [--mic \| --file F]` | Stream audio (stdin by default) to the voice agent and print its replies. `--json`, `--no-listen`, `--url`, `--token`, `--silence`, `--threshold`. See docs/41. |
| `status [--json]` | Install, version, service, port, health, token — one screen. |
| `doctor [--json]` | Check Node, the native binding, config, data dir, agent CLI, port. |
| `update [--stash] [--dry-run] [--branch <name>]` | Update this install. |
| `token [--new]` | Print the pairing token, or mint a fresh one. |
| `prepare-vosk [--force]` | Fetch the wake-word model now (the bridge also does on first boot). |
| `version`, `--version` | Package version, plus branch and commit in a clone. |
| `help`, `--help` | Usage screen. `agentvoice <command> --help` shows just that command and its options. |

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

Every check comes with a remedy:

| Check | Fails / warns when |
| --- | --- |
| `node` | Older than Node 20. |
| `sqlite` | The `better-sqlite3` native binding will not load — not built, or built for another Node (each gets its own fix). |
| `config.json` | Missing or unparseable. Warns when project discovery has nowhere to look (its hot paths do not exist, or it is off and no projects are listed). |
| `data dir` | The directory holding `DB_PATH` is not writable (tested by writing, not by `access()`). |
| `APP_TOKEN` | Absent (warn) or shorter than the 16 characters the bridge's own schema demands (fail). |
| `agent CLI` | The CLI named by `settings.agentClient` cannot be found. With no config yet, the one the packaged example selects. |
| `port` | The configured port is held by something that is not AgentVoice. |
| `service` | None installed, or installed but not running (warn). |
| `linger` | A systemd user unit without `loginctl enable-linger` — it stops at logout (warn). |
| `agent sign-in` | The running bridge reports the agent CLI is not signed in. |
| `hosting` | The running bridge's hosting provider fails its own checks (Tailscale up, HTTPS, tunnel…). |

The last two need the bridge: `doctor` asks it over the API with this home's
`APP_TOKEN`, rather than loading every provider itself. With the bridge down
they are skipped, and a `bridge` warning says so.

Warnings do not fail the run — "no `APP_TOKEN` yet" is a normal state five
seconds after install. Any `fail` exits 1.

The agent-CLI check covers all four providers (Cursor, Codex, Claude Code,
Codewhale). It resolves the binary exactly as the providers do — `<CLI>_PATH`
override, then the known install directories, then `PATH` (with `PATHEXT` on
Windows) — from the same table, `src/providers/binSpecs.ts`. That module
imports nothing but the resolver, so the CLI gets the providers' answer without
importing the provider registry, which would drag the whole executor stack,
`@aws-sdk` included, into a management CLI. `/healthz` reports `cliFound` and
the CLI version from the bridge's side.

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
- **npm** → `npm install -g @ratitisrad/agentvoice@latest`, dropping `-g` (and
  running in the depending project) when the install is a local dependency.
  Global vs local is read from where the package sits: a global prefix has no
  `package.json` of its own, a project that depends on us does.
- **npx** → nothing to update in place; prints `npx @ratitisrad/agentvoice@latest`.
- **system** (.deb / .rpm) → prints the `apt` / `dnf` command and changes
  nothing — `npm i -g` would install a second copy the service never runs.
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

## The service

`start`, `stop`, `restart`, `status` and `logs` drive whichever service manager
the platform has:

| Platform | Service | Detected by |
| --- | --- | --- |
| Linux | `agentvoice.service` | `systemctl --user cat` (the user unit `service install` and `scripts/install-systemd.sh` write), then `systemctl cat` (a system unit) — the order `scripts/update.sh` and `src/serve/index.ts` use. |
| macOS | `com.agentvoice.bridge` launchd agent | `~/Library/LaunchAgents/com.agentvoice.bridge.plist` exists. |
| Windows | `AgentVoice` service (NSSM) | `sc.exe query AgentVoice` — the service `scripts/setup.ps1` has always installed. |

None found: say so, and point at `agentvoice service install` or `agentvoice run`.

A system unit needs root, so it is driven through `sudo -n` — non-interactive on
purpose. A CLI that silently blocks on a hidden password prompt is worse than
one that says "passwordless sudo required". A Windows service needs an elevated
terminal; that is reported, not worked around.

`agentvoice restart` is deliberately *not* `scripts/restart.sh`: that script
rebuilds first, which is an update concern. This bounces the service and nothing
else, which is what you want after editing `config.json`.

### `service install`

Installs a service that runs **as you** — the bridge spawns your agent CLIs with
your sign-ins and edits your projects — pointing at this install's Node and
launcher by absolute path, with `AGENTVOICE_HOME` pinned and a `PATH` that
includes the per-user bin directories agent CLIs install into.

- **Linux** writes a systemd user unit; `--now` enables and starts it and
  reminds you about `loginctl enable-linger`.
- **macOS** writes a launchd agent (`RunAtLoad`, restart on crash, output in
  `<home>/logs/launchd.log`); `--now` bootstraps it.
- **Windows** installs an NSSM service (needs `nssm.exe` on `PATH` or in a
  clone's `tools/`, and an elevated terminal), then tells you how to make it run
  under your account rather than LocalSystem.

`--dry-run` prints what it would write or run. An existing, different service is
left alone unless you pass `--force`. From the npx cache it refuses: npm may
delete that cache, taking the service's target with it.

## Structure

```
bin/agentvoice.mjs     shim: import dist/cli.js, call main()
src/cli/index.ts       argv dispatch, usage screen, exit codes
src/cli/silence.ts     silences the bridge's pino logger (imported first)
src/cli/args.ts        flag parser
src/cli/out.ts         colour, aligned key/value rendering
src/cli/exec.ts        capture (probes) vs passthrough (long jobs)
src/cli/home.ts        home resolution, seeding, .env and config.json reading
src/cli/service.ts     service detection and control (systemd, launchd, Windows)
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
every install, including the many that never turn wake words on. The bridge
fetches it itself on first boot; this command does the same thing ahead of time
(before going offline) or again (`--force`, to repair a bad download).

```bash
agentvoice prepare-vosk           # fetch it now
agentvoice prepare-vosk --force   # fetch it again
```

Both paths run the same code (`src/serve/ensureVoskModel.ts`) and land in
`<AGENTVOICE_HOME>/vosk` (`~/.agentvoice/vosk`), which no `npm update`, `ng
build` or package upgrade touches. A model already present in any directory
`/vosk/` is served from — `web/public/vosk` in a clone included — counts, so
nothing is downloaded twice. A running bridge serves it straight away.

Without it, wake words are unavailable and on-screen Speak / Cancel still work,
which is what `touchControls` already falls back to.
