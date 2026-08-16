# 05 — MCP Tools & cursor-agent Integration

This is the executor layer: the constrained tool surface and how it drives the
`cursor-agent` CLI. All CLI knowledge is isolated here so the (beta) CLI's churn
touches one module.

## Tool surface (single source of truth)

Define each tool **once** with a zod schema; emit both the MCP tool registration
and the provider function-tool definition from it (DRY). Full details and CLI
backing for every tool are in [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md).

**16 tools total across 8 groups:**

| # | Tool | Group | Description |
| --- | --- | --- | --- |
| 1 | `agent_list_projects` | Project | List/search the project registry |
| 2 | `agent_set_project` | Project | Set the sticky active project |
| 3 | `agent_list_models` | Model | List/filter available models (CLI-backed, cached) |
| 4 | `agent_set_model` | Model | Set the sticky active model (default: `auto`) |
| 5 | `agent_submit` | Execute | Submit work to cursor-agent (async, returns job_id) |
| 6 | `agent_ask` | Execute | Read-only repo Q&A (`--mode ask`, no writes) |
| 7 | `agent_job_status` | Job | Poll a job's status and progress events |
| 8 | `agent_job_stop` | Job | Kill a running job |
| 9 | `agent_new_session` | Session | Drop resume id; start fresh thread next submit |
| 10 | `agent_session_info` | Session | Read persisted session state for a project |
| 11 | `agent_diff` | Git | Current uncommitted diff (stat + optional patch) |
| 12 | `agent_revert` | Git | Git-level undo to pre-job checkpoint |
| 13 | `agent_info` | System | CLI version, OS, model (`about --format json`) |
| 14 | `agent_status` | System | Auth status + user info (`status --format json`) |
| 15 | `agent_mcp_list` | MCP inspect | List executor's configured MCP servers |
| 16 | `agent_mcp_tools` | MCP inspect | List tools for an executor MCP server |
| 17 | `cursor_answer_question` | Interaction | Reply to a blocking `cursor/ask_question` mid-run |
| 18 | `cursor_approve_plan` | Interaction | Accept/reject a blocking `cursor/create_plan` mid-run |

> **ACP transport:** `agent_submit`, `agent_ask`, `agent_job_stop`,
> `agent_new_session`, `cursor_answer_question`, and `cursor_approve_plan` are
> backed by `cursor-agent acp` (JSON-RPC over stdio) rather than `--print`.
> ACP enables live subscriptions, cursor's questions, plan approvals, per-call
> permissions, and clean cancellation. See [`12-acp-and-live-monitoring.md`](./12-acp-and-live-monitoring.md).

### Project selection & resolution (server-side)

Project selection is the riskiest input in the whole system — a misheard name
could point the agent at the wrong codebase. The strategy is **liberal accept,
strict execute** (Postel's Law): the model maps fuzzy speech to a candidate, but
the bridge is the final authority and only ever runs against an allowlisted path.

1. **Catalog is injected into the session.** At token-mint time the bridge bakes
   the project catalog (canonical `name` + `aliases[]` + short `description`)
   into the realtime session config / system prompt. The model therefore *knows
   the valid options* and resolves "the budget thing" → `budget` itself.
2. **Sticky active project.** The session has one **active project** (stored
   server-side, see `07`). Once set, `project` can be omitted on every tool call
   — dad says it once, not every sentence (lowers cognitive load; Miller's Law).
3. **Server-side resolution + validation** for any `project` value received:
   - Normalize → match against `name` then `aliases` (case-insensitive).
   - If no exact match, run a **fuzzy backstop** (e.g., Dice/Levenshtein) to find
     the nearest candidate(s) above a confidence threshold.
   - **Unique confident match** → use it (resolve to the registry's absolute path
     for `--workspace`).
   - **No match / multiple plausible matches / below threshold** → return a
     structured `needs_disambiguation` error listing the candidates, so the model
     asks the user instead of guessing.
   - **Disabled project** → reject.
4. **Never trust a path.** The caller supplies a *name*, never a path. The path
   comes from the registry only (see `03-security.md`).
5. **Readback for risky ops.** For `agent_submit`/`agent_revert`, the system
   prompt instructs the model to confirm the target on low confidence or for
   destructive intent ("Working in **budget** — go ahead?"). Avoid confirming on
   every call (don't nag; preserve flow).

### Validation rules (enforced server-side)

- `project` → resolve via registry name/alias/fuzzy; reject if unresolved,
  ambiguous, or disabled. Use the registry's stored absolute path as
  `--workspace`. If omitted, use the session's active project; if there is none,
  return `no_active_project` so the model asks which one.
- `prompt` → non-empty, length-capped; passed as a single argv element.
- `question` (`agent_ask`) → non-empty, length-capped; run **only** in
  `--mode ask` (read-only); never resolves to a writing run.
- `mode` → enum; default per config (recommend `agent`, with optional
  `plan`-first config toggle).
- `job_id` / `session_id` → must exist in state DB and belong to the project.

## cursor-agent CLI — confirmed reference (June 2026)

> Beta: "flags may change between releases." Pin the version; add a startup
> self-check (`cursor-agent --help` / `--list-models`) and log the detected
> version.

| Flag | Use here |
| --- | --- |
| `-p, --print` | Always (non-interactive). |
| `--output-format text\|json\|stream-json` | Use **`stream-json`** for progress + final result. |
| `--stream-partial-output` | Optional; char-level deltas (probably unnecessary for voice). |
| `--resume [chatId]` | Resume per-project session. |
| `--continue` | Alias for `--resume=-1` (most recent). |
| `--model <model>` | Model ID from `cursor-agent models`. Set from `session_state.active_model` (default: `auto`). No hardcoded value in config. |
| `--mode plan\|ask` | `agent` is default; `plan` for plan-first flow. |
| `--force` / `--yolo` | Auto-run + apply changes. *"Force allow commands unless explicitly denied"* — **the `deny` list still applies.** Without it, headless silently denies non-allowlisted commands (no prompt either way). |
| `--trust` | Required for headless; skips workspace-trust prompt. Scope to the allowlisted workspace. |
| `--sandbox enabled\|disabled` | Optional defense-in-depth (OS-level boundaries; non-sandboxable commands fail instead of prompting). |
| `--workspace <dir>` | **Always** — from registry, never from caller. |
| `--approve-mcps` | Only if the executor agent itself uses MCPs. |
| `agent ls` | Lists **chat sessions for a workspace**, not projects. Scoped to `--workspace` (defaults to cwd). Use `cursor-agent ls --workspace <registry path>` when recovering a specific project's sessions. |

### Pre-run flags (configurable, default = force)

Every invocation gets a **configurable pre-run flag set** applied uniformly,
sourced from `config.json` (`preRunFlags`). Default:

```jsonc
"preRunFlags": ["--force", "--trust"]   // auto-run + apply + skip trust prompt
```

- This is the one place to change run behavior for *all* requests (e.g., add
  `--sandbox`, drop `--force` for a propose-only mode).
- `--force` honors the **`deny` list** in the CLI permission files (see `03`/`07`),
  so "default force" still has hard guardrails.
- In headless mode with `--force`, cursor never blocks for questions or
  permissions — it proceeds or exits with an error message in the result.

### Canonical invocation (built in code, `shell:false`)

```ts
const args = [
  "-p",
  "--output-format", "stream-json",
  "--workspace", project.path,        // from registry — never from caller
  "--model", session.activeModel,     // from session_state; set via agent_set_model
  ...config.preRunFlags,              // default: ["--force", "--trust"]
  ...(resumeId ? ["--resume", resumeId] : []),
  ...(mode === "plan" ? ["--mode", "plan"] : []),
  prompt,                             // single argv element — only caller-controlled value
];
spawn("cursor-agent", args, { cwd: project.path, shell: false, env: scopedEnv });
```

### `agent_ask` invocation (read-only context for the voice model)

```ts
const args = [
  "-p",
  "--output-format", "json",          // single answer; no progress needed
  "--workspace", project.path,
  "--model", session.activeModel,     // same model as the work session
  "--mode", "ask",                    // READ-ONLY: cannot edit or run mutating cmds
  ...config.preRunFlags,              // harmless in ask mode (read-only)
  question,
];
// one-shot (no --resume) — exploration never pollutes the work session thread
```

`agent_ask` is the **only** repo-context path for the voice model. It runs in
`--mode ask` (read-only exploration — searches/reads, makes no changes), returns
the answer text, and does **not** persist to the project's work session.

### Model management (no hardcoded IDs)

**No model IDs appear in `config.json`.** Instead:

- `agent_list_models` calls `cursor-agent models`, parses the plain-text output
  into `[{id, displayName}]`, and **caches the result** (TTL from
  `settings.modelCacheTtlMs`, e.g., 3600000 = 1 hour) in the SQLite state.
  Dad can say *"Cursor, what models are available?"* or *"show me the Claude models"*.
- `agent_set_model` sets `session_state.active_model` (validated against the
  cache). Dad can say *"Cursor, use Opus"* and the model filters/fuzzy-matches the
  display name.
- If no model is set for the session, the bridge passes `auto` (Cursor chooses
  the account default). This is the sensible default — dad doesn't have to pick.
- **Cache refresh:** on cache miss or expiry, call `cursor-agent models` again.
  The bridge can also expose a `cursor_refresh_models` tool or do it automatically
  at startup and on TTL expiry.

```
session_state
  ├─ active_project  (set by agent_set_project or web dropdown)
  └─ active_model    (set by agent_set_model; default: "auto")

model_cache
  ├─ fetched_at
  ├─ ttl_ms
  └─ models: [{id, displayName}]
```

`--workspace` is **always** present and always comes from the registry
(`project.path`), never from caller input. It is the single value that scopes
both *where edits happen* and *which session history is visible* (sessions are
workspace-scoped — see `07`).

## Session bootstrap & resume flow

This is the lifecycle of a project's `cursor-agent` session, from first run to
every subsequent resume. The bridge owns this; the model only calls tools.

```
agent_submit(project) → resolve project → path (registry)
        │
        ├─ resume_id known for this project?
        │
        ├─ NO  → FIRST RUN (bootstrap a session)
        │        spawn: cursor-agent -p --output-format stream-json
        │               --workspace <path> --force --trust "<prompt>"
        │        parse stream → capture session_id from the events
        │               (the "grep id" step: read it off the JSON, not the screen)
        │        persist project.resume_id = session_id
        │
        └─ YES → RESUME
                 spawn: cursor-agent -p --output-format stream-json
                        --workspace <path> --resume <resume_id> --force --trust "<prompt>"
                 (must reuse the SAME --workspace the session was created under)
        │
        └─ on completion: refresh project.resume_id from the run's session_id
```

Key points:

1. **Capture the id from structured output, not by scraping a TTY.** With
   `--output-format stream-json`/`json` the `session_id` is a field on the
   events/result object. Read it programmatically; do not regex a terminal
   screen. (`strip-ansi` remains defensive-only.) The id is consistent within a
   run.
2. **Persist per project.** `resume_id` is stored on the `project` row (see `07`)
   so a project always continues its own thread across bridge restarts.
3. **`--resume` is always paired with `--workspace`.** Resuming under a different
   workspace silently starts fresh (CLI sessions are workspace-scoped). The
   bridge guarantees the pairing because both derive from the same registry entry.
4. **`agent_new_session`** clears `resume_id` for a project, forcing the next
   `agent_submit` back through the FIRST-RUN path.
5. **Initial prompt construction.** The bridge builds the prompt argv element
   from the model's task text only; workspace/flags are added in code. No host
   shell string is ever assembled (`shell:false`, args array).

## Auto-run, permissions & clarifying questions

A hard requirement for the voice flow: **`cursor-agent` must never stall waiting
for input.** Confirmed behavior (Cursor CLI docs, June 2026):

### Headless mode is non-blocking by design

- **No permission dialogs in print mode.** Without `--force`, any non-allowlisted
  command is **silently denied** and the agent adapts to the failure on its own;
  with `--force`, it runs. **Neither path pops an interactive prompt** — so a
  headless run cannot hang on "approve this command?".
- **Applying changes = `--force`.** Without `--force`, file changes are only
  *proposed, not applied*; with `--force` (alias `--yolo`) they are written
  directly. "Accepting changes" is therefore a flag, not an interactive step.
- **`--trust`** skips the workspace-trust prompt (headless only).
- **No interactive Q&A.** Print mode has no back-and-forth; the agent runs to
  completion and returns. `thinking` events are suppressed. The agent does **not**
  pause mid-run to ask the user a question.

### Recommended invocation: auto-run **with a deny list** (not blanket yolo)

`--force` means *"force allow commands unless explicitly denied"* — the **`deny`
list still applies under `--force`.** This gives us auto-run flow *and* hard
guardrails. Configure CLI permissions in `~/.cursor/cli-config.json` (global) or
`<workspace>/.cursor/cli.json` (project-level; only `permissions` is allowed
there):

```json
{
  "version": 1,
  "permissions": {
    "allow": [],
    "deny": [
      "Shell(rm)",
      "Shell(sudo)",
      "Shell(git:push*)",
      "Read(.env*)",
      "Write(**/*.key)",
      "Write(**/*.pem)"
    ]
  }
}
```

- Deny rules take precedence over allow; entries are exact-string/glob tokens
  (`Shell(...)`, `Read(...)`, `Write(...)`, `WebFetch(...)`, `Mcp(...)`).
- This blocks destructive/sensitive ops **even in auto-run**, satisfying the
  "enforce security at the boundary" rule without losing hands-free flow.
- Optional defense-in-depth: `--sandbox enabled` (OS-level filesystem/network
  boundaries; non-sandboxable commands simply fail and the agent reacts).
- `--approve-mcps` only if the executor agent itself calls MCP servers.

Provision these permission files as part of deployment (see `07`) so every
project the bridge runs gets the same guardrails. Treat the deny list as part of
the security configuration, version-controlled via `config.example`.

### Is there a flag to "skip cursor's questions"?

**No dedicated flag — and none is needed.** Headless mode has no interactive Q&A;
the agent never *pops* a question. Two practical implications:

- **It won't stall asking.** With `preRunFlags` defaulting to `--force --trust`,
  permission/trust decisions are pre-answered. There is no prompt to skip.
- **To keep the agent heads-down (don't emit questions, just proceed),** steer it
  via the **prompt text** the bridge builds, e.g. prepend a standing instruction:
  *"Make reasonable assumptions and proceed; do not ask clarifying questions."*
  This is prompt-level, not a CLI flag. The questions we *want* come from the
  **voice model**, not the agent.

### Clarifying questions: the voice model stays "dumb"

Design rule (confirmed): the **voice model has no repo access**. It only drafts
prompts and converses. To gain context it **delegates to `cursor-agent` in ask
mode** instead of guessing. Order of operations when the voice model is unsure:

```
Dad says something ambiguous
      │
      ├─ Is the ambiguity about the REPO/code? ── yes ──► agent_ask(question)   [--mode ask, read-only]
      │        (e.g., "is there already a settings page?")        │
      │                                                           ▼
      │                                              use the answer to either:
      │                                                ├─ draft a precise agent_submit, or
      │                                                └─ ask Dad a better, informed question
      │
      └─ Is the ambiguity about INTENT/preference? ── yes ──► ask Dad directly
               (e.g., "dark mode default on or off?")   (cursor can't know this)
```

So the voice model **asks `cursor` before it asks Dad** for anything the repo
could answer, and only bothers Dad with intent/preference decisions. This keeps
the voice model cheap/simple while answers stay grounded in the real codebase.

### After a run — clarification via session resume

If a `agent_submit` run's **final output** still contains a question or flags
uncertainty, the bridge returns that text → the voice model **speaks it to Dad**
→ Dad answers → the voice model calls `agent_submit` again, which **`--resume`s
the same session** with the answer. Multi-turn is **session-level**, not a
blocking in-run prompt. (`--mode plan` remains available for plan-first
confirmation on risky/vague tasks.)

Net separation of concerns:

- **Voice model** = conversational layer (drafts prompts, asks Dad, asks
  `agent_ask` for repo facts). No repo access, stays dumb.
- **cursor-agent (ask)** = read-only knowledge source for the voice model.
- **cursor-agent (agent)** = run-to-completion executor that applies changes.

## ⚠️ The node-pty question (validate first, then likely drop)

The original plan assumed `node-pty` is required for a TTY. **Cursor's docs say
print mode is inferred for non-TTY/piped stdin**, and `--print` exists precisely
for scripts/CI. Plan:

1. **Spike (Milestone 0):** run the canonical invocation via plain
   `child_process.spawn` (no pty) and confirm clean `stream-json` output and a
   final JSON object.
2. If clean → **drop `node-pty`** (one less native dep, less ANSI noise).
3. If the CLI misbehaves without a TTY → fall back to `node-pty`, but keep parsing
   identical. Either way, parsing logic is transport-agnostic.

Document the spike outcome in `08-decisions-and-risks.md`.

## Output parsing

- **`stream-json`**: newline-delimited JSON events. Each line = one event,
  terminated `\n`. `thinking` events are suppressed in print mode. Consume:
  - tool-call start/finish events → emit progress for "still working…" narration
    (correlate via tool-call IDs).
  - the terminal result event → the spoken summary + session id.
- **`json`** (alternative): a single JSON object emitted at completion (no
  deltas). Simpler, but no progress — worse for voice.
- **Robustness:** ignore unknown fields (forward-compatible, per docs); still run
  `strip-ansi` defensively before parse; tolerate partial trailing lines by
  buffering until `\n`.
- **Session id:** stays consistent within a run; capture it and persist as the
  project's resume id.

## Job lifecycle & concurrency

```
agent_submit → create job row (status=running) → spawn agent
   │  stream events → append to job.progress + audit
   │  on final result → status=done, store summary/diffstat, persist resume id
   │  on nonzero exit / parse error → status=error, capture stderr tail
agent_job_status(job_id) → read job row
agent_job_stop(job_id) → SIGTERM→SIGKILL the pid, status=stopped
```

- **Concurrency cap** (config, e.g., 1–2 jobs) to protect the home machine.
- **Per-job timeout**; on timeout → stop + status=error with a spoken apology.
- **Reaping:** track pid; ensure no zombies on crash/restart; on bridge startup,
  mark orphaned `running` jobs as `error` (their process died with the old
  bridge).

## Git strategy (`agent_revert` / `agent_diff`) via `simple-git`

Decision needed at implementation time (tracked in `08`): how aggressive is
revert? Recommended safe default:

- Before each `agent_submit`, record the current HEAD + whether the tree is
  clean (a checkpoint row).
- `agent_diff` → `git diff --stat` (+ optional full patch) of working tree.
- `agent_revert` → restore to the pre-job checkpoint:
  `git stash`/`git checkout -- .` for uncommitted changes, or
  `git reset --hard <checkpoint>` if the agent committed (configurable; destructive
  resets gated behind a confirmation in the voice flow).
- Never auto-`git push`. Pushing is out of scope for the voice flow.

## Provider function-call ↔ MCP mapping

Because tools are defined once (zod), generate:

- **MCP** registrations for the in-process MCP server.
- **Provider function tools** for the realtime `session.update` config.

The phone forwards a provider function call `{name, arguments}` to the bridge;
the bridge dispatches by `name` into the same handler the MCP server uses. One
handler set, two entry points (DRY + reusability).
