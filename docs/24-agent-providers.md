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

Hardcoded model lists are gone. `provider.listModels()` is the only source of
truth:

- **Cursor** — `cursor-agent models`, cached in SQLite (`provider_model_cache`
  table, keyed by provider id so switching `agentClient` never serves a stale
  cross-provider cache).
- **Codex** / **Claude Code** — probed from the installed CLI at runtime with
  a documented fallback list if the CLI has no `models` subcommand.
- **Codewhale** — `codewhale model list`, which prints `<model-id> (<provider>)`
  per line across every configured provider. That read is offline and instant;
  `codewhale models` hits the live provider API and needs a working key, so it
  is only the fallback. Entries are keyed by bare model id rather than
  `provider/model`, because `--model` takes an id and lets Codewhale resolve the
  route itself — the provider name rides along in the display label so the
  picker still says where a model came from.

### REST API (`src/routes/providerModels.ts`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/providers/models?query=` | GET | Cached/live model list for the active provider + `active_model` + `supports_selection` |
| `/api/providers/model` | POST | Set the active model (`{ model }`) |

If the CLI is unauthenticated, `GET /api/providers/models` returns **HTTP 400**
with a human-readable message (not 500) and triggers the same `auth_required`
push as a failed spawn — the PWA model picker shows the message inline
(`p-message severity="warn"`) instead of crashing.

The Voice tab shows a model picker (hidden entirely when
`supportsModelSelection` is false) and an active-model chip:

Select overlays use `appendTo="body"`, `baseZIndex: 1300` (above the mobile tabbar
at 1200), and virtual scroll only when the list is long. Item height must match
multi-line project/session templates (~56px). The active model id (including
`auto`) is always injected into options so the trigger never renders blank.

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
`<Provider> · <Model>`.

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
