# 08 — Decision Log & Open Risks

ADR-style log of confirmed decisions (with rationale) plus the risks/open items
still to resolve. Update this file as reality is discovered.

## Confirmed decisions

### ADR-001 — Audio transport (superseded)

**Original decision:** WebRTC direct phone → speech provider.

**Current (2026):** Cascade STT + TTS on the PWA; Cursor or Bedrock for reasoning.
S2S providers removed. See [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md).
**Rationale:** Lowest latency; native capture/encode/echo-cancel/playback; far
less custom audio code than a PCM-over-WebSocket relay.
**Consequence:** Tool calls must be routed back through the phone; secured via
authenticated relay to the bridge (ADR-006). Provider key never on device →
ephemeral tokens (ADR-007).

### ADR-002 — Provider (superseded)

**Original:** OpenAI Realtime primary behind `provider.ts`.

**Current (2026):** No S2S providers. Reasoning via Cursor MCP or Bedrock Converse;
audio via WebKit + Amazon Polly/Transcribe.
Interface keeps it swappable (Open/Closed, reusability).
**Consequence:** Target the **GA** schema (`session.type:"realtime"`,
`audio.input/output`, `output_modalities`, no `OpenAI-Beta` header).

### ADR-003 — Trigger: latching push-to-talk + voice start/end
**Decision:** A latching push-to-talk toggle is the authoritative control (tap
on / tap off). While open, the model acts only on **"Cursor…"-prefixed**
utterances and recognizes **"cursor end"** to stop. **"cursor start"** resumes
acting within an open session.
**Rationale:** Reliable, battery-friendly, Safari-friendly; the prefix
disambiguates directed commands from ambient speech.
**Consequence:** True always-on "cursor start" while mic is OFF needs an
on-device wake-word spotter → deferred to v2 (ADR-009 risk).

### ADR-004 — Safety boundary is the MCP wrapper, not shell
**Decision:** The system's safety comes from the **constrained MCP tool set
surface + project allowlist + git revert + app token**, not from sandboxing raw
shell. (Reframed per user guidance: "this is an MCP wrapper, not unlimited shell
access.")
**Rationale:** The voice model can only do what the tools allow; workspace paths
come from the registry; edits are git-revertable.
**Consequence:** `cursor-agent` runs with `--force --trust` non-interactively
(required to not stall) but is bounded by workspace + tools. Optional
defense-in-depth: `--sandbox enabled`, plan-mode-first, dedicated OS user.

### ADR-005 — Access: single user + app-level token
**Decision:** Single user (dad). A high-entropy app token is enforced on **every**
HTTP request and WS frame, on top of Tailscale.
**Rationale:** Network auth alone is insufficient (project security rule);
defense in depth.
**Consequence:** Token rotation via `.env`; multi-user is a future change
(per-user tokens + identity column).

### ADR-006 — Tool calls routed via authenticated phone relay (not remote-MCP)
**Decision:** Function calls arrive on the WebRTC data channel at the phone, which
forwards them to the bridge over an authenticated WS; the bridge executes.
**Rationale:** Keeps the bridge **tailnet-only** (no public Funnel exposure of a
home machine). Phone is an authenticated relay, never an executor.
**Rejected:** Provider remote-MCP-by-URL (would require public Funnel) — kept as a
documented opt-in only.

### ADR-007 — Ephemeral provider tokens; key only on the bridge
**Decision:** Bridge mints short-TTL ephemeral tokens (with session+tool config
baked in); the provider API key never reaches the browser.

### ADR-008 — State store: SQLite (`better-sqlite3`)
**Decision:** SQLite over a JSON file.
**Rationale:** History, audit trail, safe concurrent access; trivial for
single-user scale.

### ADR-010 — Project selection: sticky active project + liberal-accept/strict-execute
**Decision:** Projects are chosen by **voice name**, with a **sticky active
project** per session (set via `cursor_set_project`, defaulted on all other
tools). The model maps fuzzy speech to a candidate using the **injected catalog**
(`name` + `aliases[]` + `description`); the **bridge** re-resolves and validates
against the allowlist and only ever runs against a registry path. Ambiguous /
low-confidence / missing → structured error → the model asks. `cursor_submit`,
`cursor_revert`, `cursor_diff`, `cursor_new_session` take `project` as
**optional**; new tools `cursor_list_projects` and `cursor_set_project` added.
**Rationale:** Say-it-once ergonomics (Miller's Law), graceful recovery from STT
mishears (Postel's Law), and the wrong-codebase risk is contained by server-side
allowlist resolution (R-3).
**Consequence:** Registry gains `aliases`/`description`; a `session_state` table
holds the active project; readback is used for low-confidence/destructive ops.

### ADR-011 — Two-file config on host + manual registration + dual (manual/voice) selection
**Decision:** All configuration lives on the hosting computer in **two files**:
`config.json` (non-secret **settings + the project directory registry**) and
`.env` (**secrets/keys only** — provider key, app token; perms `600`, never
committed). Projects are **registered manually** by the owner editing
`config.json` over SSH/iSH — never via voice/dad. Project selection works **two
interchangeable ways** over the same registry: a **web-app dropdown** (manual)
and the **voice agent** (`cursor_list_projects` view/search + `cursor_set_project`),
both updating the same `session_state.active_project`.
**Rationale:** Clear operator control surface; secrets isolated from settings
(rotation, git hygiene); both human and agent can pick projects; allowlist stays
operator-controlled (security at the API level).
**Consequence:** `GET /api/projects` returns **names + descriptions only, never
paths**; the frontend sends a name, the bridge resolves the path. Startup
reconciles the registry table from `config.json` while preserving `resume_id`.
Precedence: `.env` > `config.json` > defaults.

### ADR-012 — Session bootstrap: --workspace from registry, capture id, resume
**Decision:** Every `cursor-agent` run passes `--workspace <registry path>`.
First run for a project bootstraps a session; the bridge **captures `session_id`
from the structured (`stream-json`/`json`) output** and persists it as the
project's `resume_id`; subsequent runs use `--resume <id>` **paired with the same
`--workspace`**. `cursor_new_session` clears the id to force a fresh thread.
**Rationale:** Matches how the CLI scopes sessions to a workspace; reliable,
restart-surviving continuity; no TTY scraping.
**Consequence:** Resume must always reuse the original workspace (else the CLI
starts fresh). Capturing the id reads a JSON field, not the terminal screen.

### ADR-013 — Auto-run via `--force --trust` + deny list; questions handled out-of-run
**Decision:** `cursor-agent` runs headless with **`--force --trust`** so it never
stalls on permission/trust prompts and **applies** changes (not just proposes).
Guardrails come from a CLI permissions **`deny` list** (which `--force` honors),
provisioned by the operator (`~/.cursor/cli-config.json` and/or
`<workspace>/.cursor/cli.json`), optionally plus `--sandbox enabled`. Clarifying
questions are **not** done via blocking CLI prompts (headless has no interactive
Q&A): the **voice model asks dad before submit**, and any question in the agent's
**final output** is spoken back and answered on the next `--resume` turn.
`--mode plan` is available for plan-first confirmation.
**Rationale:** Confirmed from Cursor CLI docs (June 2026): headless mode is
**non-blocking** — without `--force` non-allowlisted commands are *silently
denied* (agent adapts), with `--force` they run; neither prompts. This makes a
hands-free voice loop viable while the deny list preserves "security at the
boundary." Separating conversation (voice model) from execution (run-to-
completion agent) is the natural fit.
**Consequence:** Multi-turn clarification is **session-level** (via `--resume`),
not in-run. Operator must provision/maintain the deny list as security config.
Resolves the core concern behind R-11.

### ADR-014 — Voice model stays "dumb"; gains repo context via `cursor_ask` (ask mode)
**Decision:** The realtime voice model has **no direct repo access**. It only
converses and drafts prompts. For any repo/code uncertainty it calls a new
read-only tool **`cursor_ask`** (`cursor-agent --mode ask`) **before** asking Dad
a question or drafting a `cursor_submit`. It asks **Dad** only for
intent/preference the repo can't answer. `cursor_ask` is one-shot and does not
pollute the project's work session.
**Rationale:** Keeps the voice model cheap/simple and grounds all repo facts in
the real codebase via the read-only ask mode, reducing wrong assumptions. Clean
separation: voice = talk + draft; cursor-agent (ask) = know; cursor-agent (agent)
= do.
**Consequence:** New `cursor_ask` tool (read-only, hard-coded `--mode ask`, still
allowlist-validated + audited). System prompt encodes "ask cursor before Dad for
repo facts."

### ADR-017 — CLI-only (`--print --output-format stream-json`) is the production executor transport
**Decision:** The production executor uses `cursor-agent -p --output-format
stream-json` (NDJSON over stdout) as the sole execution path. ACP was considered
and prototyped but is **not adopted**. The TUI is not used.
**Rationale:** `--print --output-format stream-json` is a stable, structured
data stream that is straightforward to parse with readline. It gives us: tool
invocations, file writes, shell commands, progress, final result + session_id —
everything we need to narrate progress and detect completion. ACP is more
complex (persistent process, auth lifecycle, JSON-RPC state machine) with the
same end result, and its `cursor/ask_question` feature is unnecessary since
headless mode with `--force` does not block for questions. CLI-only is more
reliable and lower maintenance — verified by a comparison of the two approaches.
The watcher engine (`watcher.ts` + `narrator.ts`) covers the monitoring gap:
events from the NDJSON stream are classified and injected into the realtime
session so Dad hears progress as it happens.
**Consequence:** 16 MCP tools total (the two ACP interaction tools
`cursor_answer_question` / `cursor_approve_plan` are dropped). No ACP process
management. Mid-run questions are handled by prompt-steering (`--force` +
system prompt) rather than a structured question/answer protocol.

### ADR-016 — No hardcoded model IDs; models fetched live via CLI + MCP tools
**Decision:** No model ID is hardcoded anywhere in config. Models are fetched
live at runtime via `cursor-agent models`, parsed, cached in SQLite
(`model_cache`, TTL from `settings.modelCacheTtlMs`), and exposed via two new
MCP tools: `cursor_list_models` (list/search) and `cursor_set_model` (set sticky
session model). All invocations use `session_state.active_model` (default:
`"auto"` = Cursor account default). Filtering is server-side (case-insensitive
contains on `id` + `displayName`); no native CLI filter flag exists.
**Rationale:** The model list changes with CLI updates (verified: 140+ models,
June 2026). Hardcoding breaks silently; live fetch + session selection is robust
and gives dad and the voice model natural model switching ("use Opus", "show me
the fast models").
**Consequence:** New `model_cache` table; `session_state` gains `active_model`;
per-project `model` column in registry as an optional override.

### ADR-015 — Configurable pre-run flags (default `--force --trust`); no "skip questions" flag exists
**Decision:** All `cursor-agent` invocations apply a configurable
`settings.preRunFlags` (default `["--force", "--trust"]`) — one place to control
run behavior for every request. There is **no CLI flag to suppress the agent's
questions**, and none is needed: headless mode never prompts interactively. To
keep the agent heads-down, the bridge **prompt-steers** it ("make reasonable
assumptions; proceed; don't ask"). User-facing questions come from the voice
model, not the agent.
**Rationale:** Matches confirmed CLI behavior; centralizes run policy; preserves
the deny-list guardrails (which `--force` honors).
**Consequence:** Changing run posture (e.g., propose-only, add `--sandbox`) is a
config edit. "Skip questions" is a prompt-engineering concern, not a flag.

### ADR-018 — TTS wake-word echo: compare Vosk heard text to current TTS line


**Decision:** Keep the Vosk wake spotter **active during TTS** so user barge-in
works. When Vosk fires while TTS is playing, ignore the detection if the wake
phrase appears in `TtsPile.getCurrentLine()` (assistant echo from the speaker).
Otherwise run the normal barge-in path: stop TTS, snapshot
`heard_complete` / `heard_partial` / `not_spoken`, attach as `tts_interrupt` on
the next `user_turn`, deliver to Cursor via `next_voice_turn()`.

**Rejected:** Pausing the wake spotter for the duration of TTS — prevents echo but
also prevents the user from interrupting speech.

**Rationale:** Hands-free users need both barge-in and stable playback when the
assistant mentions the wake phrase in spoken output. Line-level TTS bookkeeping
plus whole-word phrase matching is sufficient without playback-position APIs.

**Consequence:** `TtsPile.getCurrentLine()`, `textContainsWakePhrase()` in
`wake-words.ts`, Vosk `onMatch(phrase, heard)` passes raw transcript. Documented
in [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md).

### ADR-019 — Optimus UI + local appearance theming

**Decision:** Use `@openng/optimus-ui` (MIT PrimeNG fork) for the PWA component
library. Drive light/dark/system and primary tone through Optimus theming
(`provideOptimus` + `updatePrimaryPalette`), persisted only in browser
`localStorage` (`cv-appearance`) — never `config.json` / admin API. Browser TTS
voice pickers use Optimus `p-select` with `virtualScroll` + lazy chunking so
Firefox-scale remote voice lists stay responsive.

**Rejected:** Native `<select>` workaround; always-on dark via hardcoded
`html.p-dark`; brand colors hardcoded in SCSS.

**Consequence:** Templates keep `p-*` selectors. App CSS is structural and uses
`--p-*` tokens only. Dark mode class is `.app-dark` on `<html>`.

## Open items / risks (to resolve during build)

| ID | Item | Plan to resolve | Severity |
| --- | --- | --- | --- |
| R-1 | **Does `cursor-agent` truly work without a pty?** Docs say yes (non-TTY infers print mode). | Milestone 0 Spike A validates. Fallback: add `node-pty`; parsing unchanged. | Med |
| R-2 | **`cursor-agent` is beta — flags and stream-json schema may change.** | Pin CLI version; startup self-check (`about --format json`); isolate all CLI knowledge in `src/executor/cursorAgent.ts`. | Med |
| R-3 | **STT accuracy for code-y Polish/English + project names.** Misheard names → wrong project. | Voice-friendly registry names; confirm-before-apply for risky ops; readback of chosen project. | Med |
| R-4 | **Latency of long jobs vs conversational feel.** | Async function calling + progress narration; never silent. | Med |
| R-5 | **"cursor start" while mic OFF** needs always-listening. | v1: button is the on-switch; v2 optional on-device wake-word spotter. | Low |
| R-6 | **GA Realtime event/schema details** differ from older snippets. | Build against GA docs; Spike C/D validates exact event names. | Med |
| R-7 | **Destructive-but-valid agent actions** (e.g., "delete the tests"). | git checkpoint + `cursor_revert`; optional plan-mode-first + voice confirm. | Med |
| R-8 | **iOS Safari audio quirks** (autoplay unlock, call/Siri interruptions, backgrounding). | Wake Lock + silent media keepalive + auto-resume on visibility; keep sessions foreground. See [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md). | Low |
| R-9 | **Git revert aggressiveness** (uncommitted vs committed agent changes). | Define checkpoint policy in `git.ts`; gate hard resets behind confirmation. | Low |
| R-10 | **Two billing accounts** (provider key vs Cursor subscription) — cost visibility. | Document expected usage; ephemeral token TTL limits provider abuse. | Low |
| R-11 | **Agent mid-run questions.** With `--force`, headless cursor does not block for questions — it proceeds or aborts. If cursor does abort mid-task asking for clarification, the voice model receives the partial result text, speaks it back, and the user can follow up with `cursor_submit` + `--resume`. | Prompt-steering in system prompt ("proceed; make reasonable assumptions"). Worst case: dad answers a question via voice and a new `cursor_submit` continues the thread. | Low |
| R-12 | **Auto-run blast radius even with deny list** (a valid prompt does harm inside an allowlisted workspace). | Deny list (`Shell(rm)`, `Read(.env*)`, no `git push`, …) + optional `--sandbox enabled` + `cursor_revert`; least-priv OS user; deny list maintained as security config. | Med |

## Questions that may still need user input (non-blocking for docs)

1. **Project naming convention** — which projects, what voice-friendly names?
   (Needed to seed the registry; collect during Milestone 1/6.)
2. **`cursor-agent` executor model** — no hardcoding; dad selects via
   `cursor_set_model` (or leaves as `auto` = Cursor account default). Models
   fetched live from `cursor-agent models` via `cursor_list_models`.
3. **Plan-mode-first default?** — Should `cursor_submit` propose a plan and wait
   for "yes" before applying, or apply directly? (Recommended: configurable;
   start with direct + git revert, add plan-first if it feels risky.)
4. **Revert hard-reset policy** — OK to `git reset --hard` to a checkpoint when
   the agent committed, gated behind voice confirmation? (Recommended: yes,
   gated.)

These don't block the documentation; flag them when implementation reaches the
relevant milestone.
