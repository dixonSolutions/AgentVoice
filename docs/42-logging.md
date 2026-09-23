# 42 — Session Logs and Voice Transcripts

> Added: September 2026

The bridge used to log only to stdout — journald under systemd, the terminal
otherwise — so `agentvoice run`, an npm install or a manual start kept no
history at all, and nothing but the turn database recorded what was said in a
voice session. Every run now writes its own files into its home (docs/35),
however it was started:

```
<home>/logs/                            settings.logging.dir or $AGENTVOICE_LOG_DIR
└── serve/                              run profile (serve = host, test = npm run dev)
    ├── bridge/
    │   ├── 2026-09-23_14-05-12.log     this run
    │   ├── 2026-09-22_08-30-01.log     kept as plain text (keepPlain)
    │   └── 2026-09-21_19-02-44.log.gz  older → gzipped
    ├── transcripts/
    │   ├── 2026-09-23_14-06-01.log     one per voice session
    │   └── 2026-09-22_08-31-15.log.gz
    └── console/                        raw stdout of a nohup'd bridge (scripts/start.sh)
```

Terminal and journald output is unchanged, and `agentvoice logs` /
`journalctl --user -u agentvoice` still read the journal for a systemd install.

## Bridge session logs

One file per bridge process, named by its start time. The header says which
run it is, and a footer is written on shutdown — **a file with no footer is a
crash**, and its last lines are the ones you want (writes are synchronous, so
nothing is lost in a buffer on `process.exit`).

```
# AgentVoice bridge log
# opened 2026-09-23 20:23:10.759 (UTC+10:00) — session start
# session started 2026-09-23 20:23:10.758
# version=0.1.0 (4386b85) · node=v26.9.0 · pid=544294 · runMode=serve · agent=claude-code · workflow=agent_native · cwd=/opt/agentvoice
2026-09-23 20:23:10.757 INFO  [config] config loaded configPath=/opt/agentvoice/config.json projectCount=1 runMode=serve
2026-09-23 20:23:11.404 INFO  [api:audio-stream] audio stream started client="e2e pipe" listen=true stt="Self-hosted Whisper"
2026-09-23 20:23:13.361 INFO  [api:audio-stream] stream segment transcribed index=1 audioMs=1600 latencyMs=97 provider=local_whisper
…
# session ended 2026-09-23 20:23:19.431 (SIGTERM)
```

- Lines are text, not JSON: timestamp, level, `[module]`, message, then
  `key=value` fields. Errors keep their stack, indented under the line.
- Lines logged before the logger was configured (config loading, migrations)
  are buffered and written at the top, so the file tells the whole startup.
- The file level is `settings.logging.fileLevel` (default `debug`),
  independent of `settings.logLevel`, which drives the terminal. Debug adds a
  request log for `/api`, `/mcp` and `/ws` (method, path, status, ms; query
  strings dropped) — failed requests are logged at warn/error at any level.
- A long-running service rolls to a new file at local midnight and past
  `maxFileMb`, so no file spans two dates; the new file's header names the one
  it continues.

### Module loggers now honour `logLevel`

Every module declares `const log = childLogger('x')` at import time, before
config is loaded. Those loggers used to bind to a default logger that
`initLogger()` then replaced, so `settings.logLevel` never reached most of the
bridge. `childLogger()` now returns a thin proxy that resolves against the live
root, so the level and destinations chosen at startup apply everywhere.

## Voice transcripts

What was said, by whom, and when — one file per voice session:

```
# AgentVoice voice transcript
# opened 2026-09-23 20:23:11.403 (UTC+10:00) — session start
# agent=Claude Code · workflow=agent_native · input=turns · pid=544294
[20:23:11] EVENT: phone connected
[20:23:13] USER (voice): fix the login redirect
[20:23:13] EVENT: Claude Code starting (pid 544552) — project site
[20:23:14] AGENT: Looking at the auth middleware now.
[20:23:40] NARRATOR: The worker finished — two files changed.
[20:23:41] USER (stream): and add a test for it
# session ended 2026-09-23 20:31:02.118 (all voice clients disconnected)
```

- A session is a stretch of time with at least one voice client connected — the
  phone's `/ws` socket, a desk client on `/ws/events`, or an audio pipe
  (docs/41). It ends two minutes after the last one leaves, so a phone
  reconnecting on a flaky network stays in one file.
- `USER` lines carry the turn's source — `phone`, `desk`, `rest`, or `stream`
  (the direct audio pipe). `AGENT` is every `speak()` (`AGENT (unheard)` when it
  was buffered for the away digest), `NARRATOR` the worker narration, `EVENT`
  connections and agent lifecycle. The turn database (`/api/turns`, docs/37)
  still holds the structured thread; the transcript is the readable,
  greppable, per-session file.
- Transcripts contain what you said to the agent. They stay on the host, in the
  gitignored `logs/`, and are never part of the npm package; set
  `settings.logging.transcripts: false` to stop recording them.

## Compression and retention

When more than `keepPlain` plain files sit in a folder, the older ones are
gzipped (`.log.gz`, about a tenth of the size). This runs:

- at startup, once the server has bound its port — proof that no other process
  of the same profile is still writing to that folder (each profile has its own
  port, which is also why the folders are split by profile);
- after a midnight / size rollover;
- when a transcript closes.

A file that is open is never touched, and a gzip is written to `.partial` and
renamed, so an interrupted run never leaves a truncated archive. Nothing is
compressed on shutdown — the process is exiting — the next start does it.
Archives are kept forever unless `retentionDays` is set.

## Reading them

```bash
agentvoice logs                       # the journal — or, with no service unit, the session log
agentvoice logs --files -f            # follow the session log file across rollovers
agentvoice logs --list                # bridge logs + transcripts on disk, newest first
agentvoice logs --transcripts         # the newest transcript
agentvoice logs --cat latest          # print a file (.gz decompressed)
agentvoice logs --transcripts --cat 2026-09-22_08-31-15.log.gz
npm run cli -- logs --list            # same, from a clone
zgrep 'stream segment' ~/.agentvoice/logs/serve/bridge/*.gz
```

`--profile test` reads the `npm run dev` folder instead of the one
`settings.runMode` names.

In the app, **Config → Updates & service → Service journal** shows journald when the bridge runs as a
systemd unit with entries, and otherwise the current session file — so the
viewer now works for npm installs and manual runs too.

## Settings

`settings.logging` in `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `"logs"` | base folder, relative to the working directory |
| `files` | `true` | write the bridge session log |
| `fileLevel` | `"debug"` | level for the session log |
| `transcripts` | `true` | write voice transcripts |
| `keepPlain` | `3` | newest plain files kept per folder |
| `maxFileMb` | `25` | roll to a new file past this size (0 = only at midnight) |
| `retentionDays` | `0` | delete archives older than this (0 = keep all) |

Environment: `AGENTVOICE_LOG_DIR` overrides `dir`; `LOG_LEVEL` overrides
`logLevel` for the terminal.

## Service notes

- **systemd user unit** (`scripts/install-systemd.sh`): `WorkingDirectory` is
  the checkout, so files land in `<checkout>/logs/serve/`. Nothing to configure.
- **system unit** (`agentvoice.service`): `ProtectSystem=strict` makes the
  filesystem read-only except `ReadWritePaths`, which now includes
  `/opt/agentvoice/logs`.
- **manual start** (`scripts/start.sh` / `restart.sh` without systemd): stdout
  goes to `logs/serve/console/<date>.log` instead of one ever-growing
  `logs/bridge.log`, and those captures are compressed like everything else.
- **npm install / `agentvoice run`**: the bridge runs in its home, so the files
  land in `<home>/logs/` next to `config.json` (`~/.agentvoice/logs` by
  default). The CLI itself logs nothing there — `src/cli/silence.ts` turns every
  destination off for management commands.

The terminal format replaced `pino-pretty`, which was a devDependency: an
installed package running on a TTY had no copy of it.

Code: `src/log.ts`, `src/logging/` (`sessionLog.ts`, `transcripts.ts`,
`logFiles.ts`, `format.ts`, `tail.ts`), `src/cli/commands/logFiles.ts`.
