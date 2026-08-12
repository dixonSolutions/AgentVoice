# 24 — Agent Providers: In-App Auth, Live Models, Generic MCP Tools

> Added: August 2026

`docs/23-multi-agent-client.md` covers CLI installation, invocation flags, and
MCP registration. This doc covers what was built on top of that: a single
`AgentProvider` abstraction (`src/providers/agents/`) that adds **phone-driven
sign-in**, **live model selection**, and **generic MCP tool aliases** for
Cursor, Codex, and Claude Code — without duplicating logic per CLI.

## Why

Cursor, Codex, and Claude Code each authenticate, list models, and report
errors differently. Before this, only Cursor had auth-error detection, model
caching, and MCP tools; Codex/Claude were second-class. `AgentProvider` is the
one interface the rest of the app depends on — `executor/cursorAgent.ts`,
`executor/voiceAgent.ts`, `mcp/tools/model.ts`, and `mcp/tools/system.ts` no
longer branch on `agentClient`; they call `getActiveProvider()` and let the
provider file (`cursor.ts` / `codex.ts` / `claude.ts`) own the CLI-specific
details. Adding a fourth CLI means one new file + one registry entry.

See [`src/providers/agents/types.ts`](../src/providers/agents/types.ts) for
the full interface.

## Auth flows per CLI

| Flow          | Cursor | Codex | Claude Code |
| ------------- | :----: | :---: | :---------: |
| `browser-url` | ✅ (`cursor-agent login`) | — | ✅ (`claude setup-token`, captured automatically) |
| `device-code` | — | ✅ (`codex login --device-auth`) | — |
| `token-paste` | — | — | ✅ (paste an existing setup token) |
| `api-key`     | ✅ (Cursor Dashboard key) | ✅ (OpenAI key) | ✅ (Anthropic key) |

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
`<Provider> · <Model>`.

## Generic MCP tool aliases

`agent_status`, `agent_list_models`, `agent_set_model`, `agent_info` delegate
to whichever provider is active. The original `cursor_*` tool names
(`cursor_status`, `cursor_list_models`, …) keep working as aliases — existing
MCP configs and prompts referencing them are unaffected. See
[`src/mcp/schemas.ts`](../src/mcp/schemas.ts) and
[`src/mcp/handlers.ts`](../src/mcp/handlers.ts).

## Prompt generalization

`prompts/agentvoice/system.md` and `mcp-instructions.md` use
`{{AGENT_DISPLAY_NAME}}` instead of a hardcoded "Cursor". It's substituted at
render time in [`src/mcp/loadCursorVoicePrompt.ts`](../src/mcp/loadCursorVoicePrompt.ts)
with `getActiveProvider().displayName`, so the same prompt text narrates
correctly regardless of which CLI is active.

## Known gap — `OPENAI_API_KEY` stripping bug, fixed

Before this change, `buildCursorAgentEnv()` unconditionally stripped
`OPENAI_API_KEY` from the child process environment, which broke Codex even
though it needs that variable. Env construction now goes through
`provider.env(base)`, so each provider only strips the keys that actually
conflict with it.
