# 37 — Seeing running sessions and injecting into them by voice

> Added: September 2026. Design, not yet implemented. Companion to
> [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md),
> [`23-multi-agent-client.md`](./23-multi-agent-client.md) and
> [`36-disconnect-and-background-work.md`](./36-disconnect-and-background-work.md).

The idea: list every active agent session from the phone and send a message
into any of them by voice.

## Decisions (2026-09-15)

| Question | Decision |
| --- | --- |
| Scope of the first version | **Everything** — bridge sessions, past sessions, and sessions the user started themselves, including injection into those via **fork** or an **opt-in mailbox** |
| Writing into a user's terminal (TTY) | **Never** |

## What exists today

- **`inject` never delivers.** `handleInject`
  (`src/mcp/server/agentToolHandlers.ts`) writes to `active.handle.stdin`, but
  `AgentHandle` (`src/executor/agentProcess.ts`) has no `stdin` and agents are
  spawned with `stdio: ['ignore', 'pipe', 'pipe']`. Every call returns
  `delivered: false`. It also only matches the singleton worker — worktree
  workers and the voice agent never match — and a `-p <prompt>` run would not
  read new input mid-run anyway.
- **Resume ids are per project, not per job.** `submitJob` calls
  `setProjectResumeId` for every worker, worktree workers included, so
  parallel workers overwrite each other.
- **Cursor and Codex worktree workers skip `--resume`.**
- **The session picker only sees bridge rows** — `listCursorSessionsForProject`
  (`src/state/jobs.ts`) reads `job` and `voice_agent_run`, never the CLIs'
  own stores.
- **One global voice turn queue** (`src/mcp/server/turnQueue.ts` — "extend to
  a Map<sessionKey, VoiceTurnQueue> if multi-session is needed").
- Externally started sessions are normal: the host machine routinely runs
  several `claude remote-control` processes and plain `claude` sessions.

## 1. Session kinds and discovery

| Kind | Discovery |
| --- | --- |
| A. Voice agent | `getActiveVoiceAgent()` |
| B. Bridge workers (singleton + worktree pool) | `getAllActiveRuns()`; store session id per job, add a spoken name |
| C. Past resumable sessions | New optional provider `listSessions(project)` reading the CLI store: Claude `~/.claude/projects/*/<id>.jsonl`, Codex `~/.codex/sessions/yyyy/mm/dd/rollout-*-<id>.jsonl`, Cursor `~/.cursor/chats/<hash>/<id>/`, Codewhale `~/.codewhale/sessions/*.json` (existing `readSessions()`) |
| D. External live sessions | Same-uid process scan (`/proc/*/cmdline`, `/proc/*/cwd`), cwd matched to a registered project, paired with the newest session file (mtime = last activity) |

CLI store layouts are undocumented: treat parsing as best-effort with
`unknown` as a valid answer, as `sessionStatus()` already does.

## 2. Injection mechanisms

| Mechanism | Session kinds | Mid-run | Providers | Role |
| --- | --- | --- | --- | --- |
| Voice turn queue (`submitAgentNativeTurn`) | A | yes | all | exists |
| **MCP mailbox** — per-session queue, new `check_messages()` tool, messages also piggyback on any agent-voice tool result | B, D (opt-in) | at the next AgentVoice tool call | all (agent-voice MCP is registered for every CLI) | **baseline** |
| **Resume with a new turn** — queue, then respawn `--resume <job session id>` when the run ends or after a confirmed stop | B, C | between turns | all | **guaranteed fallback** |
| **Fork** — Claude `--fork-session`, Codewhale `fork`, others declare | C, D | no (new branch of the conversation) | per provider | safe way into an external session's context |
| Native live input — Claude stream-json stdin, Codex / Codewhale `app-server`, Cursor ACP | A, B | yes | optional `liveInput` capability | upgrade |
| Writing to a TTY (TIOCSTI, `tmux send-keys`, `/dev/pts/N`) | D | — | — | **rejected** |

Why TTY writes are rejected: TIOCSTI is disabled by default on Linux ≥ 6.2;
writing to a pts only displays text; `send-keys` races the user's typing, has
no delivery confirmation, can answer a permission prompt ("y"), and bypasses
the CLI's permission mode.

**Concurrent resume corrupts transcripts.** Before resuming a session id,
check no live process owns it (process scan + recent mtime); if one does,
fork instead.

**Opt-in mailbox for external sessions.** A session started outside the bridge
only receives mailbox messages if its agent-voice rule tells it to call
`check_messages()` — enabled per project.

## 3. Phone UX

- **Sessions list** grouped *Running (bridge)*, *Running (external)*, *Recent*.
  Row: spoken name, project, provider icon, status (thinking / tool / waiting /
  idle / done / error), elapsed, last activity, and a delivery badge
  (live / mailbox / next turn / fork / read-only).
- **Tools** — `list_sessions(scope)` and `send_to_session(handle, message,
  confirm)`; `inject` reimplemented on top; `list_agents` kept as an alias.
- **Voice naming** — auto two-word names from worktree name or first-prompt
  keywords ("auth worker"), ordinals ("the second one"), project aliases via
  `projectMatch.ts`, rename by voice ("call that one billing"), disambiguate
  by listing matches.
- **Confirmation** — read back target, delivery method and message. Optional
  for bridge workers with live/mailbox delivery; always required for external
  sessions, forks and stop-then-resume (same gate as `stop_agent`); also shown
  as a card.
- **Honest delivery** — every result carries
  `delivery: live | mailbox_pending | queued_next_turn | forked | refused`, and
  the voice agent says which happened.

## 4. Security

- Injection is prompt injection by design: an external session may run with
  bypass permissions, so anyone holding `APP_TOKEN` could drive it. External
  injection is **off by default, enabled per project**.
- Only sessions whose cwd is inside a registered project are visible
  (`assertValidProjectPath`); others are hidden, not merely read-only.
- Same uid only; never read another user's home. Multi-user needs per-user
  tokens first (docs/03).
- Transcripts contain secrets: the phone gets summaries and the last activity
  line, never raw files; bounded reads.
- Every injection is written to the `audit` table (target, method, message
  hash, confirmation).
- Resumed/forked sessions launch with the bridge's current permission mode as
  flags (provider rule), not the external session's; the UI says so.

## 5. Rollout

1. **Fixes** — `handleInject` returns a truthful reason and covers the worktree
   pool and voice agent; stop worktree jobs overwriting the project resume id;
   correct docs 11 and 16 §8.3.
2. **Bridge sessions** — `SessionDirectory` merging voice agent, active runs
   and recent rows; per-session mailbox (turn queue → map) and
   `check_messages`; `list_sessions` / `send_to_session`; queue-then-resume;
   `GET /api/sessions` + phone list over the `agent_event` stream; naming and
   confirmation.
3. **Past and external sessions** (in v1 per the decision above) — provider
   `listSessions`, same-uid process scan, fork with message, opt-in mailbox for
   external sessions, per-project enablement.
4. **Live input** — optional per-provider `sendInput()`; mailbox fallback
   where unsupported.
