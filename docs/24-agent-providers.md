# 24 — Agent Providers: In-App Auth, Live Models, Generic MCP Tools

> Added: August 2026. Extended later that month — the contract now also owns
> stream parsing, MCP registration, execution modes and session creation. See
> [`28-provider-parity-and-branding.md`](./28-provider-parity-and-branding.md).

`docs/23-multi-agent-client.md` covers CLI installation, invocation flags, and
MCP registration. This doc covers what was built on top of that: a single
`AgentProvider` abstraction (`src/providers/agents/`) that adds **phone-driven
sign-in**, **live model selection**, and **generic MCP tool aliases** for
Cursor, Codex, Claude Code, and Codewhale — without duplicating logic per CLI.

## Why

Cursor, Codex, and Claude Code each authenticate, list models, and report
errors differently. Before this, only Cursor had auth-error detection, model
caching, and MCP tools; Codex/Claude were second-class. `AgentProvider` is the
one interface the rest of the app depends on — `executor/agentProcess.ts`,
`executor/voiceAgent.ts`, `executor/watcher.ts`, `mcp/agentMcpSetup.ts`,
`mcp/tools/model.ts`, `mcp/tools/system.ts` and `mcp/tools/session.ts` no longer
branch on `agentClient`; they call `getActiveProvider()` and let the provider
file (`cursor.ts` / `codex.ts` / `claude.ts`) own the CLI-specific details.
Adding another CLI means one new file + one registry entry. Codewhale was
added that way in August 2026 and touched nothing outside
`providers/agents/codewhale.ts`, the registry map, the `AgentClient` union and
its label — see [§ Codewhale](#codewhale) for the two CLI quirks that shaped
the file.

The contract members added in the follow-up pass:

| Member                    | Owns                                                    |
| ------------------------- | ------------------------------------------------------- |
| `parseStreamEvent()`      | translating this CLI's NDJSON dialect to normalized events |
| `ensureMcpRegistration()` | where and how `agent-voice` is registered for this CLI   |
| `supportedModes()`        | which execution modes this CLI can actually *enforce*    |
| `createSession()`         | minting a resumable thread id up front, if the CLI can   |

See [`src/providers/agents/types.ts`](../src/providers/agents/types.ts) for
the full interface.

## Auth flows per CLI

| Flow          | Cursor | Codex | Claude Code | Codewhale |
| ------------- | :----: | :---: | :---------: | :-------: |
| `browser-url` | ✅ (`cursor-agent login`) | — | ✅ (`claude setup-token`, captured automatically) | ✅ (`codewhale login`) |
| `device-code` | — | ✅ (`codex login --device-auth`) | — | — |
| `token-paste` | — | — | ✅ (paste an existing setup token) | — |
| `api-key`     | ✅ (Cursor Dashboard key) | ✅ (OpenAI key) | ✅ (Anthropic key) | ✅ (key for the *active* Codewhale provider) |

Codewhale's `api-key` flow is the one that does not write to AgentVoice's
`.env`. Codewhale keys are per-provider and live in its own config plus the OS
keyring, so the pasted value is handed to
`codewhale auth set --provider <active> --api-key-stdin` instead — right scope,
right store, and never in argv or shell history.

Each provider declares its own flows via `authFlows()` — the PWA auth card
never hardcodes provider knowledge, it just renders whatever the active
provider returns.

## How phone-driven sign-in works

1. A worker or voice-agent spawn exits with an auth-looking error
   (`provider.isAuthError(exitCode, stderr)` — patterns like "not authenticated",
   "please login", `401`, per CLI).
2. `providers/agents/authNotify.ts` debounces and calls `notifyPhone({ type:
   'auth_required', provider, displayName, flows, context })` — delivered over
   the `/ws/control` socket (instant, if the PWA is open) and as a push
   notification fallback (VoIP-priority on iOS) so it lands even if the app is
   backgrounded.
3. The PWA's `AuthCardComponent` (`web/src/app/components/auth-card/`) renders
   flow-appropriate UI: a tappable URL, a device code, or a paste field.
4. The card calls the REST auth endpoints below; `browser-url`/`device-code`
   poll until the CLI's own login command resolves, `token-paste`/`api-key`
   resolve immediately after the value is validated and written to `.env` via
   `state/envFile.ts`.

### REST API (`src/routes/providerAuth.ts`)

All routes require the same Bearer `APP_TOKEN` as the rest of `/api/*` —
security is enforced at the API level, not hidden in the UI.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/providers` | GET | Every provider's install state + declared auth flows (no CLI calls) |
| `/api/providers/:id/status` | GET | Live `checkAuth()` (shells out; a few seconds) |
| `/api/providers/:id/auth/start` | POST | Start a login flow (`{ flow, pasted? }`) → `{ attemptId, url?, code?, instructions, settled, result }` |
| `/api/providers/:id/auth/poll/:attemptId` | GET | Non-blocking peek at an in-flight attempt |
| `/api/providers/:id/auth/cancel/:attemptId` | POST | Abort an in-flight login |

## Live model selection

Hardcoded model lists are gone — and so are hardcoded effort levels. Every
provider answers `listModels()` by asking its own CLI, and every entry carries
the knobs *that* CLI reports for *that* model:

```ts
interface ModelEntry {
  id: string;             // what gets stored / handed back to the provider
  displayName: string;
  description?: string;   // the CLI's own blurb ("Opus 5 with 1M context · …")
  vendor?: string;        // picker group: Anthropic / OpenAI / Google / xAI / …
  efforts?: string[];     // effort levels this model accepts — [] = no knob
  defaultEffort?: string | null;
  fast?: boolean;         // a fast / priority tier exists
  variants?: ModelVariant[]; // Cursor only — see below
}
```

That is why the picker offers `low … max` for Opus and nothing for Haiku,
`ultra` for GPT-6 on Codex, and only `high` / `max` for Cursor's Claude 4.6
rows: the CLI said so, in the same probe that produced the list.

| CLI | Where the list comes from | Effort knob | Fast tier |
| --- | --- | --- | --- |
| **Cursor** | `cursor-agent models` | baked into the id (`gpt-5.3-codex-high`) | baked into the id (`…-fast`) |
| **Claude Code** | stream-json `initialize` control response (`models[]`, the same catalog `/model` shows) | `--effort <level>` from `supportedEffortLevels` | `--settings '{"fastMode":true}'` where `supportsFastMode` |
| **Codex** | `codex debug models` (JSON catalog; `--bundled` fallback when offline) | `-c model_reasoning_effort="<level>"` from `supported_reasoning_levels` | `-c service_tier="priority"` where `service_tiers` lists `priority` |
| **Codewhale** | `codewhale model list` | none reported | none reported |

**Claude Code** has no `models` subcommand, but its stream-json control channel
does: `providers/agents/claude.ts` spawns `claude -p --input-format stream-json
--output-format stream-json` with an empty `--strict-mcp-config`, writes one
`{"type":"control_request","request":{"subtype":"initialize"}}` line, reads the
`control_response` (which carries `models[]` with `supportsEffort`,
`supportedEffortLevels`, `supportsFastMode`, `disabled`) and kills the process.
No API call is made. The CLI's `default` row maps to the shared `auto`
sentinel (no `--model`). If the control channel is unavailable (older CLI) the
provider falls back to parsing `claude --help`, which still lists the accepted
`--effort` levels and `--model` aliases — nothing is invented either way.

**Codex** reads `codex debug models`, filters `visibility: "list"` /
`supported_in_api`, and keeps the catalog's `priority` order. The `auto` row
defers to `~/.codex/config.toml`; when that names a listed model, `auto`
inherits its levels so "use high effort" works without picking a model first.

**Cursor** prints one row per (model, effort, speed) combination — thirty
near-identical ids. `groupCursorModels()` folds them into families and keeps
every printed id as a `variant`:

```
gpt-5.3-codex        efforts low / high / xhigh · fast tier
  ├─ gpt-5.3-codex-low        (low, standard)
  ├─ gpt-5.3-codex            (default, standard)
  ├─ gpt-5.3-codex-high-fast  (high, fast)
  └─ …
```

The family id is what gets stored; at spawn time `resolveVariantId()` maps
(family, effort, fast) back to the printed id — and to the nearest offered
pair when the exact one does not exist (`cursor-grok-4.6` has `high` only as
`high-fast`). Older Anthropic rows put `-thinking` after the effort
(`claude-4.6-opus-high-thinking`); the tokenizer peels it off and re-attaches
it so both spellings land in one "… Thinking" family. `extra-high` is read as
`xhigh`, `none` is a real tier (reasoning off).

### Selection semantics (`state/models.ts`)

A selection is `{ model, effort, fast }`, stored per session
(`session_state.active_effort` / `active_fast`) and as the bridge default
(`settings.defaultActiveEffort` / `defaultActiveFast`). `resolveSelection()`
is the one place that decides whether a request is something the CLI accepts:

- an unlisted effort is refused with the accepted levels when it was asked for
  explicitly (`strict`), or silently dropped when it was merely inherited from
  the previous model;
- `fast` is cleared for models without a fast tier;
- a concrete Cursor variant id (`claude-opus-5-thinking-high-fast`) is
  decomposed into family + effort + fast, so old sessions and voice callers
  that quote a full id keep working.

Both the REST route and the MCP tools return the *applied* selection and a
spoken-friendly label (`Opus (1M context) · High · Fast`), so the UI and the
voice agent never claim a level the CLI will not run.

### REST API (`src/routes/providerModels.ts`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/providers/models?query=&refresh=1` | GET | Cached/live model list + `active` `{model, effort, fast}` + `active_label` + `cached_at`. `refresh=1` drops the cache and re-probes the CLI. |
| `/api/providers/model` | POST | Set the selection (`{ model_id, effort?, fast?, scope? }`) — returns the applied `active` + `label` |

MCP: `agent_list_models(query?, refresh?)` and
`agent_set_model(model_id, effort?, fast?, scope?)` carry the same fields;
`prompts/agentvoice/system.md` tells the voice agent to read the accepted
levels back when a level is refused.

If the CLI is unauthenticated, `GET /api/providers/models` returns **HTTP 400**
with a human-readable message (not 500) and triggers the same `auth_required`
push as a failed spawn — the PWA model picker shows the message inline with a
Retry button instead of crashing.

### Picker (Voice tab)

Hidden entirely when `supportsModelSelection` is false. Otherwise:

- a **grouped** select (by vendor, `auto` first under the CLI's own name) with
  the CLI's description under each row and a filter that also matches variant
  ids;
- an **Effort** segmented control listing only the levels the selected model
  reports ("Default" leads when the CLI can be left to decide — for Cursor
  that means an unsuffixed id exists);
- a **Fast** switch shown only when the model has a fast tier;
- a freshness line ("48 models · from Cursor 3 min ago") with a reload button
  that re-probes the CLI;
- the active-model chip and the accordion summary both show the applied label
  (`<Provider> · <Model> · <Effort> · Fast`).

Changing any control posts the whole selection; if the bridge had to adjust it
the toast says so and the controls snap to what was applied.

Select overlays use `appendTo="body"`, `baseZIndex: 1300` (above the mobile tabbar
at 1200). Project/session pickers keep virtual scroll for long lists (item
height must match their multi-line templates, ~56px); the grouped model picker
does not use it — groups and virtual scroll do not mix, and ~50 families do not
need it. The active model id (including `auto`) is always injected into options
so the trigger never renders blank.

Because the overlay renders in `body`, long option text would otherwise stretch
the panel wider than its field. A `ResizeObserver` on the picker column
publishes its width as `--cv-select-panel-width` on `documentElement`, and
`.cv-voice-select-overlay` consumes it (with a `calc(100vw - 1.5rem)` ceiling).

The observer matters more than it looks: the value must be current *before* a
panel opens. Measuring in `onShow` sized the panel correctly but the library had
already positioned it from its content width, leaving a correct-width panel
pinned to the viewport edge. Width now follows whatever the layout gives the
field at any viewport — no fixed caps on the picker column. Option detail text
wraps to two lines (`white-space: normal` is required; the theme sets `nowrap`
on options).

## Generic MCP tool aliases

`agent_status`, `agent_list_models`, `agent_set_model`, `agent_info` delegate
to whichever provider is active. The original `cursor_*` tool names
(`agent_job_status`, `agent_list_models`, …) keep working as aliases — existing
MCP configs and prompts referencing them are unaffected. See
[`src/mcp/schemas.ts`](../src/mcp/schemas.ts) and
[`src/mcp/handlers.ts`](../src/mcp/handlers.ts).

## Prompt generalization

`prompts/agentvoice/system.md` and `mcp-instructions.md` use
`{{AGENT_DISPLAY_NAME}}` instead of a hardcoded "Cursor". It's substituted at
render time in [`src/mcp/agentVoicePrompt.ts`](../src/mcp/agentVoicePrompt.ts)
with `getActiveProvider().displayName`, so the same prompt text narrates
correctly regardless of which CLI is active.

## Known gap — `OPENAI_API_KEY` stripping bug, fixed

Before this change, `buildCursorAgentEnv()` unconditionally stripped
`OPENAI_API_KEY` from the child process environment, which broke Codex even
though it needs that variable. Env construction now goes through
`provider.env(base)`, so each provider only strips the keys that actually
conflict with it.

## Codewhale

`codewhale` is a Rust coding agent with a first-class headless surface:

```bash
codewhale exec --auto --output-format stream-json "<prompt>"
```

It slotted into the existing contract without changing it. Two CLI behaviours
did shape `providers/agents/codewhale.ts`, and both are worth knowing before
editing that file.

### The session id is redacted in stream-json

Every other client publishes a resumable id on its stream. Codewhale does not:
`session_capture.content` and `metadata.session_id` both pass through
`redacted_identifier_for_log()` and come out as `<redacted:…>` FNV
fingerprints, and `metadata.resume_command` is the fixed string
`codewhale exec --resume <redacted-session-id>`. Parsing harder cannot help —
the value is genuinely not in the stream.

What *is* in the terminal receipt, unredacted, is `metadata.workspace`. So the
provider reads `~/.codewhale/sessions/*.json` (each carrying
`metadata.id` / `metadata.workspace` / `metadata.updated_at`) and emits the
`session` event for the most recently updated session matching that workspace.

This is a heuristic and is documented as one: two concurrent runs in the same
workspace could race, and the loser would resume the winner's thread. It is
bounded by AgentVoice running one voice session per project, and
`executor/resumeGuard.ts` still recovers at runtime. The alternative — no
resume at all — means every turn starts a cold thread, which is worse.

The same store answers `sessionStatus()`. Codewhale accepts a unique id
*prefix* as well as a full id (`codewhale sessions` prints 8-char prefixes), so
the check matches on prefix too.

### There is no run-start event

`init` is what produces the "*Codewhale started working on …*" narration — the
first thing a hands-free user hears. Codewhale's exec stream has no
`system/init` equivalent; its first line is whatever the model produced.

`turn_usage` carries a 1-based `turn` field scoped to the run, so `turn === 1`
is used as the run-start marker. It is stateless (no cross-line bookkeeping in
a parser shared by every job) and reliable, at the cost of firing after the
first model call completes rather than at spawn. A few seconds of lateness is
a much smaller problem than the silence that a missing `init` caused for Codex
and Claude Code before [`28`](./28-provider-parity-and-branding.md).

### Modes

`supportedModes()` returns `['agent', 'ask']`. `exec` reaches `AppMode::Agent`
(with `--auto`) or a plain one-shot response (without) — there is no plan mode
on the headless path, so `plan` is refused rather than silently downgraded, per
the rule that a read-only-sounding tool name must never run a writing agent.

`ask` is enforced twice over: omitting `--auto` removes the tool surface
entirely, and `--sandbox read-only` refuses writes even if that ever changes.

### MCP registration

`~/.codewhale/mcp.json`, using `bearer_token_env_var` rather than a literal
`Authorization` header, so `APP_TOKEN` never lands in the file — Codewhale's own
MCP docs warn that a literal header value "lives in plain text" there, and users
paste that file into issues. Same approach as the Codex provider.

One trap: Codewhale's root key is `servers`, with `mcpServers` declared as a
serde **alias** — one field with two accepted spellings, not two fields.
Writing both makes the file fail to parse as a duplicate field, so registration
merges into whichever key the file already uses and deletes the other.
