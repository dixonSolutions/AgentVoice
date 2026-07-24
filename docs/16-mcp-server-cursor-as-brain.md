# 16 — MCP Server: Cursor as Brain

> **Design document:** `cursor_voice_mcp_design.docx` (dixonSolutions, June 2026)
>
> This document records the proposed architecture, an honest evaluation of its
> strengths and weaknesses, the solutions adopted, and the implementation roadmap.

---

## 1 — The Core Shift

The design proposes removing the intermediate LLM (Claude on Bedrock) from the
conversation loop and making **Cursor itself the reasoning layer**.

| Epoch | Flow |
| --- | --- |
| **Before** (current `llm_intelligence`) | Voice → STT → Claude (Bedrock) → `cursor_*` tools → cursor-agent CLI |
| **After** (proposed) | Voice → STT → Cursor via MCP `next_voice_turn()` → `speak()` tool → TTS → user |

In the proposed model the bridge is a thin I/O pipe, not an intelligence layer.
Cursor's native context window, model, and reasoning do the work.

---

## 2 — How Cursor Discovers the MCP Server

The bridge exposes an **MCP HTTP server** at `/mcp`. On voice session start the
bridge ensures **global** `~/.cursor/mcp.json` registers `cursor-voice` so
Cursor loads it in **every workspace** (not per-project):

```json
{
  "mcpServers": {
    "cursor-voice": {
      "url": "https://<tailscale-hostname>:8787/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer <app-token>" }
    }
  }
}
```

Restart Cursor after the first global install. The bridge exposes the tool
manifest over HTTP. From that point Cursor's conversational agent has the full
`cursor-voice` tool surface.

---

## 3 — Conversation Flow (Proposed)

```
1. Idle: Vosk (WASM) listens for wake phrase offline
2. Wake detected → PWA switches mic to transcription mode
3. User speaks → STT (WebKit or Amazon Transcribe) → transcript
4. Silence / submit phrase → bridge pushes turn into VoiceTurnQueue
5. Cursor (conversational agent) calls next_voice_turn() → dequeued text
   (On first turn: system prompt is prepended by the bridge)
6. Cursor reasons with full project context
7. Cursor calls speak(text) — one sentence at a time for low first-audio latency
8. Bridge handles speak(): → Amazon Polly/WebKit TTS → PWA audio
9. Cursor calls done() → PWA finishes queued TTS, then re-arms the mic
10. Loop: back to step 1
```

While a live session is ready or listening, the Voice tab shows a secondary pen
orb at the bottom-left. It opens an Optimus dialog with a multiline Markdown
request editor; Close preserves the draft and Send uses the same authenticated
session without requiring microphone input.

Live mode is a single non-scrolling viewport: session logs stay in a bounded
region at the top, while the orb, mute control, hint, and pen action remain
inside the available section below.

---

## 4 — Tool Surface Exposed to Cursor

### Voice I/O

| Tool | Signature | Purpose |
| --- | --- | --- |
| `next_voice_turn` | `(timeout_ms?: number)` | Dequeue the next user utterance (long-poll; blocks up to `timeout_ms`) |
| `speak` | `(text: string)` | Convert text → audio and push to PWA |
| `done` | `()` | Signal PWA to re-arm mic for next wake word |

### Agent Management

| Tool | Signature | Purpose |
| --- | --- | --- |
| `list_agents` | `()` | Return all running agent sessions (id, mode, status) |
| `get_agent_status` | `(id: string)` | Detailed output buffer, mode, elapsed time |
| `spawn_agent` | `(instructions: string)` | Start a new worker agent session |
| `stop_agent` | `(id: string)` | Terminate a worker agent immediately |
| `inject` | `(id: string, message: string)` | Send context to a running agent (best-effort) |

### Mode & Execution Control

| Tool | Signature | Purpose |
| --- | --- | --- |
| `set_mode` | `(id: string, mode: 'ask'\|'agent'\|'debug'\|'plan')` | Change mode of a specific agent session |
| `execute_plan` | `(id: string)` | Trigger execution on a plan-mode agent |
| `cursor_diff` | `(id?: string)` | Current git diff for a session's working directory |
| `cursor_revert` | `(id?: string)` | Revert uncommitted changes |

---

## 5 — The Two-Agent Model

Cursor's Multitask mode runs agents in parallel:

- **Conversational agent** — receives all voice input; answers questions;
  controls the worker; never does coding work.
- **Worker agent** — executes coding tasks silently; no voice connection.

The bridge maintains shared state: it collects output, mode, and status from
every running agent session and makes it queryable via `get_agent_status()`.

---

## 6 — System Prompt & Boot Lifecycle

Voice agent prompts live in `prompts/cursor-voice/system.md` (loaded by
`src/mcp/loadCursorVoicePrompt.ts`). A matching Cursor rule exists at
`.cursor/rules/cursor-voice.mdc` for `@cursor-voice` injection.

### First spawn (new session)

When no `resumeId` exists for the project, `spawnVoiceAgent()` passes the **full**
system prompt plus boot suffix to `cursor-agent -p`:

```
<prompts/cursor-voice/system.md body>

---
The cursor-voice MCP server is connected. Start the voice loop now — call next_voice_turn() immediately.
```

### Resume (existing session)

When the project has a persisted `resumeId`, only a **short** prompt is sent:

```
@cursor-voice

The cursor-voice MCP server is connected. Resume the voice loop — call next_voice_turn() immediately.
```

The `@cursor-voice` mention causes Cursor to inject the rule file. Conversation
history comes from `--resume <session_id>`; the full system prompt is **not** resent.

Implementation: `src/executor/voiceAgent.ts` — `buildVoiceBootPrompt(project)`.

### MCP server instructions

Separate from the agent boot prompt: `prompts/cursor-voice/mcp-instructions.md` is
returned as MCP server instructions when Cursor connects to `/mcp`.

---

## 7 — Design Evaluation: Strengths

| Strength | Why it matters |
| --- | --- |
| No separate LLM bill | No Bedrock inference charges for the conversational layer |
| Cursor has full project context | Repo tree, open files, recent edits — richer than a fresh LLM call |
| Single reasoning layer | Fewer prompt engineering surfaces; cleaner debugging |
| No state synchronisation | Cursor's own session has everything; no cross-process sync needed |

---

## 8 — Design Flaws and Resolutions

### 8.1 MCP is Pull, Not Push

**Problem:** The design says the bridge "sends the utterance to Cursor" — but
the MCP protocol is request/response. The bridge cannot push data to Cursor; only
Cursor can call bridge tools.

**Resolution adopted:** A `next_voice_turn(timeout_ms?)` tool is added to the
tool surface. The bridge queues incoming STT transcripts. Cursor's conversational
agent calls `next_voice_turn()` in a loop; the bridge returns the next queued
turn (long-poll pattern: if no turn is ready, the connection holds up to
`timeout_ms` ms before returning `{ turn: null }`).

### 8.2 The Conversational Agent is an Infinite Loop

**Problem:** Cursor agents are designed for finite tasks. A "listen forever"
loop (`while(true) { turn = await next_voice_turn(); ... }`) is unusual for
Cursor's agent model and may interfere with normal coding use.

**Resolution adopted:** Keep the current `llm_intelligence` workflow (Claude on
Bedrock) as the **default** runtime. The MCP SSE server is additive; users opt
into the Cursor-as-brain mode by setting `workflow.default: "cursor_native"` in
`config.json` and activating the conversational agent manually.

Long-term, an activation hook (e.g., a background task or Cursor rule) could
auto-spawn the conversational loop on session start.

### 8.3 `inject()` is Best-Effort

**Problem:** The design acknowledges that injecting context into a running agent
is unreliable. Cursor's agent architecture does not guarantee that a mid-run
message lands.

**Resolution adopted:** `inject()` is exposed as-is with a best-effort contract.
The recommended fallback (stop → spawn with amended instructions) is documented
in the system prompt. No false promises are made in the tool description.

### 8.4 No Interrupt / Preempt on `next_voice_turn`

**Problem:** If Cursor is processing a long coding task and the user says
"cancel", the voice turn queues but Cursor is not listening. The turn sits in
the queue until the current tool call returns.

**Resolution adopted:**
- `next_voice_turn()` supports a short `timeout_ms` (≤ 2 s) in the polling loop
  so Cursor interleaves quickly.
- A `VoiceInterrupt` flag is set when the word "stop" or "cancel" appears in a
  queued turn; `speak()` and tool handlers check this flag and raise early.

### 8.5 Bridge URL in Global `~/.cursor/mcp.json`

**Problem:** Each developer's Tailscale hostname differs. Committing a URL in the
repo breaks MCP auto-discovery for others.

**Resolution adopted:** Global `~/.cursor/mcp.json` is **not** committed. The
bridge auto-writes the entry on voice session prepare (URL from `config.json`
`publicBaseUrl` / run mode). Templates: `config/global-mcp.json.example` and
`.cursor/mcp.json.example`. Project-level `.cursor/mcp.json` is not required.

### 8.6 No Auth on the MCP SSE Endpoint

**Problem:** The design shows the SSE URL with no auth token, meaning any
process with network access to the bridge can call `speak()` or `spawn_agent()`.

**Resolution adopted:** The MCP SSE server requires the same Bearer token
as `/api/*`. Clients supply `Authorization: Bearer <token>` in the initial SSE
GET request. Cursor supports custom headers in `mcp.json`:

```json
{
  "mcpServers": {
    "cursor-voice": {
      "url": "https://host:3000/mcp/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The token is the same app token used by the PWA.

### 8.7 TTS Wake-Word Echo vs Barge-In

**Problem:** Assistant `speak()` output can include the wake phrase. Vosk on the
mic hears speaker echo and fires a false barge-in — stopping TTS and queuing a
spurious interrupt turn.

**Rejected fix:** Pause the wake spotter while TTS plays. That stops echo but also
blocks real user interrupts during speech.

**Resolution adopted:** On Vosk match during TTS, compare the heard transcript
with the **current TTS line** (`TtsPile.getCurrentLine()`). If the line contains
the wake phrase as whole words, reset the spotter and ignore. Otherwise:
`interruptWithSnapshot()` → `pendingTtsInterrupt` → attach to the next
`user_turn` as `tts_interrupt` → `voiceTurnQueue` → `next_voice_turn()`.

See [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) and
**ADR-018** in [`08-decisions-and-risks.md`](./08-decisions-and-risks.md).

---

## 9 — Implementation Roadmap

### Phase 1 — MCP SSE Server (current sprint)

| File | Role |
| --- | --- |
| `src/mcp/server/turnQueue.ts` | Thread-safe voice turn queue with long-poll `dequeue()` |
| `src/mcp/server/voiceToolHandlers.ts` | `speak`, `done`, `next_voice_turn` implementations |
| `src/mcp/server/agentToolHandlers.ts` | `list_agents`, `get_agent_status`, `spawn_agent`, `stop_agent`, `inject` |
| `src/mcp/server/modeToolHandlers.ts` | `set_mode`, `execute_plan`, `cursor_diff`, `cursor_revert` |
| `src/mcp/server/index.ts` | MCP `Server` using `@modelcontextprotocol/sdk`; tool dispatch |
| `src/routes/mcpSse.ts` | Fastify SSE route (`GET /mcp/sse`) + post handler (`POST /mcp`) |
| `prompts/cursor-voice/system.md` | System prompt for Cursor voice mode |
| `.cursor/mcp.json.example` | Example MCP registration file |

### Phase 2 — `cursor_native` Workflow ✅

- `workflow.default: "cursor_native"` in config.
- Intelligence WebSocket routes turns to `VoiceTurnQueue`.
- Bridge auto-spawns conversational `cursor-agent` via `src/executor/voiceAgent.ts`.
- `done()` triggers `{ type: "turn_complete" }` to the PWA.
- Voice-agent exit may TTS a fallback only if **no** `speak()` ran this user
  turn (`spokeThisTurn`). That flag is cleared on the next `user_turn`, not on
  `done()` — clearing it on `done()` caused Cursor’s final process/summary text
  to be spoken after a normal speak→done turn.

### Phase 3 — Auto-Spawn Conversational Agent ✅

- Voice agent spawns automatically on first `user_turn` when none is running.
- MCP session bound on first `/mcp` connect (`bindVoiceAgentMcpSession`).
- Boot prompt: full system prompt on first spawn; `@cursor-voice` on resume.

### Voice session MCP prepare (implemented)

Before the mic opens, the bridge runs `ensureGlobalMcpSetup()` — **not** per-project:

1. Check **global** `~/.cursor/mcp.json` for `cursor-voice` entry
   (Windows: `%USERPROFILE%\.cursor\mcp.json`)
2. Install if missing; update if `cursorVoice.version` is older than bridge
3. Set `enabled: true` and write bridge URL + Bearer token
4. User root for metadata: `~/Projects` when that folder exists, else `~`

Project-level `.cursor/mcp.json` is optional and not written. A legacy project
entry is stripped on prepare. Projects rooted at `$HOME` are skipped — their
`.cursor/mcp.json` *is* the global Cursor config and must never be deleted.

Progress streams to the PWA via `POST /api/voice-session/prepare` (SSE):

| Event | Payload |
| --- | --- |
| `session_log` | `{ phase, level, message, at }` — live voice session logs |
| `complete` | `{ ok, scope: "global", mcpPath, userRoot, hostOs, project, action, version, message }` |

Voice start is blocked until `complete.ok === true`. **Restart Cursor** after the
first global install so the MCP server list refreshes.

Template: `config/global-mcp.json.example` → copy to `~/.cursor/mcp.json`.

---

## 10 — Coexistence with `llm_intelligence`

| Mode | Who reasons | Bridge role |
| --- | --- | --- |
| `cursor_native` (default) | Cursor agent via MCP | Routes turns to `VoiceTurnQueue`; handles `speak()` |
| `llm_intelligence` | Claude on Bedrock | Routes turns to Bedrock orchestrator; handles `speak()` |

The MCP server runs regardless of workflow so Cursor can call bridge tools from any project.

---

## 11 — Related Docs

- [`02-architecture.md`](./02-architecture.md) — overall system
- [`05-mcp-and-cursor-agent.md`](./05-mcp-and-cursor-agent.md) — executor MCP tools
- [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) — full cursor_* tool surface
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — current llm_intelligence mode
