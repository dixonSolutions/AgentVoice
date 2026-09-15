# 36 — Disconnects, unattended work, and surviving a bridge restart

> Added: September 2026. Design, not yet implemented. Companion to
> [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md),
> [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) and
> [`33-permissions-and-prompt-relay.md`](./33-permissions-and-prompt-relay.md).

The idea: a setting decides whether sessions are killed or keep running when
AgentVoice loses the phone; the agent is *told* about the disconnect and acts
on that setting; a bridge restart no longer kills work; and a task that can run
unattended keeps going on its own.

## Decisions (2026-09-15)

Tracked in [#55](https://github.com/dixonSolutions/AgentVoice/issues/55).

| Question | Decision |
| --- | --- |
| Default when the phone goes away | **Keep working autonomously** |
| Permission / approval prompt while away | **Configurable**, default **push notification and wait** |
| Survive a bridge restart in v1? | **Yes — essential** |
| Resume in a new process, or keep the process alive? | **Both in v1** |

## What happens today

- **Phone disconnect.** `socket.on('close')` in `src/intelligence/ws.ts` and
  `src/server.ts` unregisters the phone and detaches the narrator (events
  buffer). The voice agent is deliberately not killed. But `speak` /
  `next_voice_turn` / `done` return `NO_VOICE_SESSION`
  (`src/mcp/server/voiceToolHandlers.ts`), whose message tells the agent to
  "use normal text" — so in practice it answers in text and exits after its
  current step. Nothing tells it a policy.
- **Workers** keep running but are still bounded by `jobTimeoutMs` (600 s,
  `src/executor/jobManager.ts`).
- **Presence is coarse.** `hasActiveVoiceSession()` counts any registered
  socket, desk `/ws/events` clients included; the control socket is a single
  slot (`src/state/controlSocket.ts`), so one of two tabs closing looks like
  the phone leaving.
- **No server-side heartbeat** on `/ws/control` or `/ws/intelligence`; a
  half-open mobile connection looks connected until TCP gives up. The PWA
  reconnects after a flat 3 s (`web/src/app/services/bridge.service.ts`).
- **Bridge shutdown kills everything.** `shutdown()` in `src/index.ts` calls
  `killActiveAgent` + `killVoiceAgent`; the systemd unit's default KillMode
  would kill children anyway; agent stdout is a pipe (EPIPE on detach);
  `markOrphanedJobs()` (`src/state/jobs.ts`) fails running jobs on boot; MCP
  transports are in-memory, so a surviving CLI gets 404 on `/mcp`.
- **Safety gap.** The `stop_agent` user-command guard
  (`src/mcp/server/index.ts`) only applies when a voice session exists.

## 1. Presence: blip vs away vs hang-up vs bridge down

New `src/state/presence.ts`, the single source of truth, tracked per client
kind (phone control WS, intelligence WS, desk WS):

`connected → grace → away`, plus `hung_up`.

- **Heartbeat** — server ping every 15 s, close after 2 missed pongs.
- **Grace** — `graceMs` (default 45 s) absorbs network changes, iOS suspension
  and the PWA reconnect. During grace `next_voice_turn` keeps long-polling.
- **Explicit hang-up** — the PWA sends `{type:'hangup'}` before closing; the
  policy applies immediately, no grace.
- **Bridge down** — nobody can be told; handled at process level (§5).

Open: does a connected desk client count as present? Proposal: policies act
on phone presence; a desk client only suppresses push.

## 2. Configuration

```ts
// src/config.ts — SettingsSchema
session: z.object({
  graceMs: z.number().int().min(0).max(300_000).default(45_000),
  onPhoneAway: z.enum(['keep_working', 'finish_turn', 'stop_all']).default('keep_working'),
  onBridgeRestart: z.enum(['kill', 'resume', 'keep_alive']).default('keep_alive'),
  unattended: z.object({
    maxRuntimeMs: z.number().int().positive().default(3_600_000),
    approvals: z.enum(['wait_push', 'deny', 'skip']).default('wait_push'),
    approvalTimeoutMs: z.number().int().default(900_000),
    secrets: z.enum(['wait_push', 'fail_fast']).default('fail_fast'),
    requireWorktree: z.boolean().default(false),
    notifyOnFinish: z.boolean().default(true),
  }).default({}),
}).default({})
```

- Optional partial `session` override per project (`ProjectConfigSchema`).
- Per-conversation override by voice ("keep going while I'm away") via an
  `agent_away_policy(policy?)` MCP tool shaped like `agent_permission_mode`.
- UI: a "Disconnect & background work" section in the config tab
  (see [`39`](./39-config-ui-and-narration-cleanup.md) for where it lands), plus a
  quick toggle on the Voice tab.

## 3. The hook — how agents learn the phone is gone

MCP is pull-only, so the signal rides on AgentVoice tool results. That works
identically for Cursor, Codex, Claude Code and Codewhale.

1. **Presence block on every agent-voice result**, like `pendingTurnNotice()`:
   `listener: { state: 'connected'|'grace'|'away', away_since, policy, instructions }`.
2. **Policy-aware voice tools** instead of a bare `NO_VOICE_SESSION`:
   - `speak` while away → `{ ok: true, delivered: false, buffered: true }`,
     recorded for the catch-up digest.
   - `next_voice_turn` while away → `{ turn: null, listener: 'away',
     retry_after_ms, message }` with a server-enforced minimum wait so the agent
     cannot burn tokens polling.
   - `done` while away with nothing queued → the run may exit normally.
   - `stop_all` → results say "stop at a safe point"; the bridge kills after
     `graceMs` regardless.
3. **Prompt** — an "away" section in `agentVoiceRuleBody()` and the MCP
   instructions; spawns started with nobody listening get a
   `VOICE_AWAY_SUFFIX` in `buildVoiceBootPrompt()`.
4. **Workers** never call voice tools; `jobManager` applies the policy for
   them (keep, kill, or switch `jobTimeoutMs` → `maxRuntimeMs`).
5. **Reconnect digest** — turns spoken while away, jobs finished, approvals
   denied or still open, diffstat. Extends `Narrator.replayBuffer()`; in
   agent_native it is attached to the first `next_voice_turn` as
   `reconnected: { away_ms, digest }` so the agent tells it in its own words.
   Open approval cards are re-sent via `getPendingApprovals()`.

## 4. Unattended mode and safety rails

- **Approvals** — only modes with `prompts: 'phone'` ask
  (docs/33). `wait_push` keeps the card open for `approvalTimeoutMs` (today a
  hardcoded 300 s) and pushes it; `deny` returns "user is away, pick another
  approach"; `skip` denies that step and tells the agent to continue other work.
- **Askpass** (all providers) — `fail_fast` by default while away so `sudo`
  does not hang for minutes (`src/routes/askpass.ts`).
- **Budgets** — wall-clock `maxRuntimeMs` per away period plus a tool-call
  count from the `Watcher`; provider budget flags (e.g. Claude `--max-turns`)
  as launch flags where supported, declared unsupported elsewhere.
- **Rails** — never raise the permission mode while away; optional
  `requireWorktree`; the existing git checkpoint; close the `stop_agent` gap;
  keep ghost-kill; a "Stop everything" action on the push notification.
- **Finish push** — the voice agent's own work emits no `job_done`; add a
  "finished while you were away" push from its `close` handler
  (`src/executor/voiceAgent.ts`).

## 5. Surviving a bridge restart (v1: both mechanisms)

| | Cursor | Codex | Claude Code | Codewhale |
| --- | --- | --- | --- | --- |
| Resume in new process | yes (worktree runs skip `--resume` today) | yes (same) | yes | yes (session id from local store; stream redacts it) |
| Keep process alive | feasible | feasible | feasible; relayed permission prompts need MCP re-attach | feasible |

**Resume.** On shutdown mark runs `interrupted` (prompt, session id, provider,
worktree) instead of letting them orphan; on boot respawn with the resume id
and "the bridge restarted mid-task; check `git status` and continue". The
in-flight tool call is lost. Lift or explicitly declare the Cursor/Codex
worktree-resume restriction.

**Keep alive.** Launch agents via `systemd-run --user --scope --collect`
(same pattern as `src/serve/index.ts`); stdout/stderr to
`data/runs/<id>.ndjson` instead of a pipe; a tiny wrapper writes
`<id>.exit`; persist pid + start time (pid-reuse safe). On boot the watcher
tails the file again. **Blocker:** in-memory MCP transports — each CLI must
re-initialise its MCP session on 404 (verify per CLI), and
`bindVoiceAgentMcpSession` ("first connection wins") needs a run token to
re-bind the right process. Unsupported on Windows / hosts without systemd →
fall back to resume.

Selection: `keep_alive` where supported, else `resume`, else `kill`.

## Risks

Unreviewed autonomous changes (mitigate: worktree, checkpoint, digest); token
burn from polling; presence flapping on mobile; the single control-socket
slot; keep-alive complexity and MCP re-attach; surprise cost.

## Rollout

1. `presence.ts` (heartbeat, grace, hang-up); `session` config + UI;
   policy-aware voice tool results and prompt section; approval and askpass
   policy; `maxRuntimeMs`; `stop_agent` fix; reconnect digest; finish push.
2. Restart survival: resume and keep-alive together, MCP session re-attach,
   per-provider declarations.
3. Per-project overrides, `agent_away_policy`, "Stop all" push action, budget
   flags; update docs 16, 19, 33.
