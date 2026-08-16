# 04 — Implementation Plan

> **Note (2026):** Speech-to-speech (WebRTC / Nova Sonic) was removed. Current voice
> path: STT/TTS cascade + `agent_native` MCP. Spikes C/D are historical.

Phased, dependency-ordered, each milestone independently testable.

> Estimates are rough effort sizes (S ≈ <½ day, M ≈ ~1 day, L ≈ 2–3 days) for one
> developer, assuming accounts/keys are available.

## Milestone 0 — De-risking spikes (do these first)

| Task | Size | Acceptance |
| --- | --- | --- |
| **Spike A — cursor-agent --print without pty.** Run `cursor-agent -p --output-format stream-json --workspace <dir> --force --trust "<prompt>"` via plain `child_process.spawn`. | M | Clean NDJSON + final JSON object with no TTY. **Records the node-pty decision.** |
| **Spike B — resume continuity.** Run twice with persisted `--resume <id>`; confirm context carries over. | S | Second run remembers first. |
| **Spike C — WebRTC + ephemeral token round-trip.** Bridge mints token; a throwaway page connects via WebRTC; you can speak and hear a reply. | M | Two-way audio works from iPhone Safari over the Tailscale HTTPS origin. |
| **Spike D — function calling over WebRTC.** Define one dummy tool; confirm the data-channel function-call event arrives and `function_call_output` round-trips. | M | Dummy tool call observed end-to-end. |

**Gate:** all three green before building the real system. If A fails (rare),
add `node-pty`; parsing is unchanged. If C/D reveal provider quirks, adjust
the provider adapter before committing.

## Milestone 1 — Bridge skeleton + security

| Task | Size |
| --- | --- |
| Project scaffold (TS, tsup, eslint/prettier, Vite for `web/`). | S |
| `config.ts` (zod-validated env), `log.ts` (structured + audit). | S |
| Fastify server: static serving + `/healthz`. | S |
| `auth.ts`: app-token middleware for HTTP + WS (constant-time, close on fail). | M |
| SQLite `db.ts` + migrations; `config.ts` loads `.env` (keys) + `config.json` (settings + projects); `registry.ts` reconciles registry from `config.json`. | M |

**Acceptance:** unauthorized requests rejected (401 / socket closed) at the API;
health endpoint green; registry loads and validates paths.

## Milestone 2 — Executor (cursor-agent integration + watcher engine)

| Task | Size |
| --- | --- |
| `agentProcess.ts`: spawn `cursor-agent -p --output-format stream-json`, flag builder, NDJSON readline parser, process lifecycle (kill/timeout/reap). | M |
| Job state: SQLite `jobs` + `job_events` rows; persist resume `session_id`; concurrency cap; orphan cleanup on startup. | M |
| `watcher.ts`: classify stream-json events (tool-use, file-write, shell-run, result, error); maintain rolling job summary; emit `NarrationEvent`s at cadence limits. | M |
| `narrator.ts`: consume `NarrationEvent`s; inject text into the active realtime session via OpenAI Realtime `conversation.item.create` so Dad hears progress without asking. | M |
| `git.ts`: pre-job checkpoint commit; `agent_diff`; `agent_revert` (hard reset to checkpoint, gated by voice confirm). | M |

**Acceptance:** submit a prompt programmatically → see watcher events → Dad
hears mid-job narration → final summary spoken → diff visible → revert works.

## Milestone 3 — MCP tool layer

| Task | Size |
| --- | --- |
| zod schemas in `schemas.ts` (single source of truth for all 16 tools). | M |
| MCP server wiring — register all 16 tools (see `11` for full surface). | M |
| **Project tools**: registry resolution, fuzzy match + `query` filter, sticky active project, disambiguation errors. | M |
| **Model tools**: `cursor-agent models` parse + SQLite cache + TTL refresh + filter. | M |
| **Session tools**: `agent_new_session` (`create-chat`), `agent_session_info` from DB. | S |
| **System tools**: `agent_info` / `agent_status` (`about/status --format json`). | S |
| **MCP inspect tools**: `agent_mcp_list`, `agent_mcp_tools` (parse plain-text output). | S |
| `agent_ask` (hard-coded `--mode ask`) + `preRunFlags` from config for all invocations. | S |
| HTTP project endpoints: `GET /api/projects` (names+descriptions, no paths) + `POST /api/active-project`. | S |
| Server-side arg validation + project allowlist enforcement + audit logging on all tools. | M |
| `functionTools.ts` — generate provider function-tool definitions from the same zod schemas. | S |

**Acceptance:** each tool callable via MCP; invalid/foreign-project args rejected
and audited; function-tool definitions generated.

## Milestone 4 — Voice provider + token + relay ✅

| Task | Size | Status |
| --- | --- | --- |
| `provider.ts` interface; OpenAI Realtime (GA) implementation. | L | ✅ |
| `token.ts`: mint ephemeral tokens with session+tool config baked in. | M | ✅ |
| `token.ts` / `provider.ts`: expose `model` in token response so PWA uses correct SDP exchange URL. | S | ✅ |
| Control WS: receive forwarded tool calls, dispatch handlers, return results. | M | ✅ |
| System prompt: "Cursor…" prefix, clarifying questions, progress narration, Polish/English, "cursor end". | M | ✅ |
| `narrator.ts` + `PhoneRelaySession`: narration relay via control WS → PWA → provider. | M | ✅ |

**Acceptance:** spoken command → clarifying question (if needed) → tool call →
agent runs → spoken summary, end to end, with the key never leaving the bridge.

## Milestone 5 — PWA ✅

| Task | Size | Status |
| --- | --- | --- |
| UI: large push-to-talk toggle, status, transcript log, connection indicator (UX-law-aligned). | M | ✅ |
| **Project dropdown**: load `GET /api/projects`, manual select → `POST /api/active-project`, active-project badge synced with voice selection. | M | ✅ |
| `audio.ts`: iOS AudioContext unlock + `<audio>` element factory. | S | ✅ |
| `webrtc.ts`: peer connection, data channel, tool-call relay (`relayToolCall` callback), narration injection, transcript events. | L | ✅ |
| Latching toggle + "cursor end"/"cursor stop" client-side detection from user speech transcript. | M | ✅ |
| Speaking-state relay: `onSpeaking` callback → bridge WS `{ type:"speaking", value }` → narrator cadence gate. | S | ✅ |
| Pending-tool-call map: WS `tool_result` / `tool_error` frames resolve/reject in-flight calls. | S | ✅ |
| PWA manifest (SVG + PNG entries), `icon.svg`, `sw.js` service worker, SW registration in HTML. | S | ✅ |
| Token entry + `localStorage` storage; `scripts/gen-icons.mjs` for PNG icon generation. | S | ✅ |

**Acceptance:** add-to-Home-Screen app; tap to talk; full loop works on dad's
iPhone over Tailscale.

## Milestone 6 — Deployment & hardening

| Task | Size |
| --- | --- |
| systemd unit (dedicated user, sandbox dirs), `tailscale serve` setup. | M |
| `.env` hygiene, log rotation, backups. | S |
| Health/monitoring; graceful agent-crash handling. | S |
| Docs: runbook + project-naming guidance with the user. | S |

**Acceptance:** survives reboot, auto-restarts, logs are useful, dad can use it
unattended.

## Milestone 7 — UX polish & optional enhancements

| Task | Size |
| --- | --- |
| Plan-mode-first toggle for `agent_submit` (confirm before apply). | M |
| Better progress narration / earcons; error recovery phrasing (Peak-End). | M |
| **(Optional v2)** on-device "cursor start" wake-word spotter. | L |
| **(Optional)** Gemini Live provider implementation behind the interface. | M |

## Testing strategy

- **Unit:** flag builder, parser (fixtures of `stream-json`), arg validation,
  auth, registry resolution.
- **Integration:** executor against a scratch git repo; revert correctness.
- **Contract:** tool schema ↔ function-tool generation stays in sync.
- **Manual/E2E:** the voice loop on the actual iPhone (the only real test of
  latency + STT of Polish/English + "Cursor…" prefix discipline).
- **Linting/build gate:** run lint + typecheck before each milestone closes
  (per project rule).

## Suggested cutline for a first usable version (MVP)

Milestones 0–5 with: push-to-talk toggle, `agent_submit` + `agent_job_status` +
`agent_revert` + `agent_diff`, `agent_set_project`/`agent_list_projects` with
sticky active project (even a 1–2 project registry exercises the selection flow),
OpenAI provider, English+Polish. Defer `agent_new_session`, plan-mode toggle,
and the v2 wake-word to later.
