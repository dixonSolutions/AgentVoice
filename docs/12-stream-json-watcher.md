# 12 — Stream-JSON Watcher & Monitoring Engine

The bridge monitors the active coding CLI in real-time by parsing its NDJSON
event stream. A lightweight **watcher** classifies events and emits **narration
events** that a **narrator** injects into the active realtime session — so the
hands-free user hears what the agent is doing without asking.

> **Since August 2026 the watcher does not parse raw CLI JSON.** Each of the
> three CLIs speaks a different dialect, and the watcher only understood
> Cursor's — so Codex and Claude Code produced no narration at all. Providers
> now translate their own stream into the normalized events in
> `src/providers/agents/events.ts` (`session` / `init` / `tool_start` /
> `tool_done` / `assistant_text` / `result` / `error`), and the watcher consumes
> those. The per-CLI shapes below describe Cursor's dialect specifically; see
> [`28-provider-parity-and-branding.md`](./28-provider-parity-and-branding.md).

> **ADR-017 note:** ACP (`cursor-agent acp`) was evaluated for this role. It was
> rejected in favour of the `--print` stream because `--print` is simpler,
> equally structured, and ACP's unique features (blocking mid-run questions,
> per-call permissions) are not needed when running with `--force`. See
> `08-decisions-and-risks.md` ADR-017 for the full rationale.

---

## How the stream-json event stream works

`cursor-agent -p --output-format stream-json` writes one JSON object per line
(NDJSON) to stdout. The bridge reads these with `readline`. Categories:

| Event kind | What it signals | Example fields |
| --- | --- | --- |
| `system:init` | Session started; carries `session_id` | `{ type, session_id }` |
| `tool_use` | Cursor called a tool (read file, write file, shell, …) | `{ type, tool, path?, cmd? }` |
| `tool_result` | Tool completed | `{ type, tool, ok }` |
| `text` / `thinking` | Cursor's reasoning stream | `{ type, content }` |
| `result` | Final outcome — job done | `{ type, summary, session_id, cost? }` |
| `error` | Job failed | `{ type, message }` |

> **Note:** The exact field names are validated empirically in Milestone 0
> Spike A and recorded in `10-cursor-cli-reference.md`. The watcher is tolerant
> of unknown fields (ignore-unknown policy) so schema drift doesn't crash it.

---

## Watcher (`src/executor/watcher.ts`)

```
spawn cursor-agent
        │
        │ stdout (NDJSON)
        ▼
   readline interface
        │
        │ one JSON line at a time
        ▼
   EventClassifier.classify(line)
        │
        ├─ captures session_id on system:init
        ├─ updates rolling JobSummary (file writes, tools called, commands run)
        ├─ rate-limits: max 1 NarrationEvent per 15s (configurable) during work
        │   + 1 on significant transitions (new file written, shell command, done)
        │
        └─► emits NarrationEvent { kind, text, jobId, ts }
```

### `NarrationEvent` kinds

| Kind | When emitted | Example text |
| --- | --- | --- |
| `job_started` | On `system:init` | "Cursor started working on the budget app." |
| `file_write` | On `tool_use` with `tool: Write` | "Cursor just wrote the settings component." |
| `shell_run` | On `tool_use` with `tool: Shell` | "Cursor is running the tests now." |
| `progress_tick` | _(disabled for TTS)_ | Formerly "Still working — read N files." Count ticks no longer speak; voice agent narrates via `get_agent_status`. |
| `job_done` | On `result` | "Done — Cursor changed 3 files. Want to see the diff?" |
| `job_error` | On `error` or non-zero exit | "Something went wrong. Cursor said: …" |
| `ghost_killed` | Task/subagent tool detected | "Stopped — Cursor tried to spawn extra agents …" |

### Ghost agent protection

When `settings.ghostKillEnabled` is `true` (default), the watcher inspects every
`tool_use_start` event. If the tool call looks like a **Task**, **subagent**, or
**explore** spawn (the pattern that created dozens of parallel CLI sessions), the
bridge:

1. Emits a `ghost_killed` narration event (Dad hears what happened).
2. Sends SIGTERM → SIGKILL to the cursor-agent process.
3. Marks the job `error` with a budget-protection message.

The cursor-agent prompt also includes anti-subagent guardrails via
`src/executor/agentPrompt.ts` (replaces the old "make reasonable assumptions"
preamble that encouraged parallel exploration).

### Rolling `JobSummary` (accumulated, not per-event)

```ts
interface JobSummary {
  filesRead: string[];
  filesWritten: string[];
  shellCommands: string[];
  lastThinking?: string;       // last 120 chars of thinking stream
  elapsedMs: number;
}
```

The narrator uses `JobSummary` to generate richer `progress_tick` narration
("still working — read 6 files, wrote 2 so far") rather than repeating
individual tool calls.

---

## Narrator (`src/executor/narrator.ts`)

The narrator receives `NarrationEvent`s and injects them into the active
OpenAI Realtime session as assistant messages. This happens **outside the
function-call cycle** — the provider receives a new assistant turn mid-session
and speaks it aloud to Dad without Dad having to ask.

### Injection mechanism (OpenAI Realtime API)

```jsonc
// Bridge sends over the realtime WebSocket:
{
  "type": "conversation.item.create",
  "item": {
    "type": "message",
    "role": "assistant",
    "content": [{ "type": "text", "text": "Cursor is running the tests now." }]
  }
}
// Followed immediately by:
{ "type": "response.create" }
// → provider speaks the injected text as a new audio response turn
```

The narrator holds a reference to the active `RealtimeSession` websocket handle.
If no session is active (Dad's mic is OFF), narration events are buffered in the
job's `job_events` table and replayed as a summary when Dad next connects.

### Cadence rules (prevent spam)

- Count-only `progress_tick` events are **not** spoken (narrator skips them; watcher no longer emits them).
- Spoken progress while workers run comes from the **voice agent** via `get_agent_status` + optional `speak()`.
- Transitions (`file_write`, `job_done`, `job_error`, `ghost_killed`) may still inject via the narrator.
- Worker poll interval is `settings.voice.workerPollTimeoutMs` (default `25000`) — how long
  `next_voice_turn` waits before the agent re-checks status.
- If the session is actively speaking (a prior injection hasn't finished TTS),
  the narrator defers until the prior turn completes.

---

## `agent_job_status` integration

`agent_job_status` returns the same `JobSummary` and all `NarrationEvent`s logged
so far. If the voice model (or Dad) asks "how's it going?", the model calls
`agent_job_status`, receives the structured summary, and speaks it — no dependency
on the narration injection path. Both paths work independently.

---

## Mid-run "questions" from cursor-agent

In headless `--force` mode, cursor-agent does **not** block for questions. If it
needs information it doesn't have, it either:

1. Makes a reasonable assumption and proceeds (common with good system prompt steering).
2. Outputs a completion `result` that mentions it was unclear — bridge speaks it
   to Dad; Dad follows up with a new `agent_submit` + `--resume`.

There is no structured question-answer protocol at the CLI level. Prompt
steering handles the vast majority of cases; `--resume` handles the rest. This
is simpler and equally effective for the Dad-as-user scenario.

---

## Sequence: a long job with mid-run narration

```
Dad: "Cursor… refactor the auth module in the budget app"
  │
  ├─ agent_submit → Bridge spawns cursor-agent, gets job_id
  ├─ voice model returns: "Working on it — I'll keep you posted"
  │
  ├─ watcher: system:init → NarrationEvent(job_started) → narrator injects
  │     Dad hears: "Cursor started working on the budget app."
  │
  ├─ watcher: tool_use Write auth/service.ts → NarrationEvent(file_write) → inject
  │     Dad hears: "Cursor just rewrote the auth service file."
  │
  ├─ (15 s cadence tick) → NarrationEvent(progress_tick) → inject
  │     Dad hears: "Still working — read 8 files, written 2 so far."
  │
  ├─ watcher: tool_use Shell "npm test" → NarrationEvent(shell_run) → inject
  │     Dad hears: "Cursor is running the tests."
  │
  ├─ watcher: result → NarrationEvent(job_done) → inject
  │     Dad hears: "Done — Cursor changed 5 files. Want me to show the diff?"
  │
Dad: "Yes, show me the diff"
  │
  └─ agent_diff → voice model describes the changes
```

---

## Configuration knobs (`config.json → settings`)

| Key | Default | Description |
| --- | --- | --- |
| `narratorCadenceMs` | `15000` | Min ms between `progress_tick` injections |
| `narratorEnabled` | `true` | Disable to silence mid-run narration |
| `narratorMaxBufferEvents` | `50` | Max narration events buffered when no session active |
| `ghostKillEnabled` | `true` | Kill cursor-agent if it spawns Task/subagent tools |
