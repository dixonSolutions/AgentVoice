# AgentVoice — Documentation

Voice-controlled coding agent: speak from an iPhone PWA, the active agent CLI
(Cursor / Codex / Claude Code) reasons with full project context, and a constrained
MCP tool layer drives worker agents on projects hosted on a home machine.

> Status: **Implemented.** This folder is the source of truth for architecture and
> behavior. Update these docs when the codebase changes (see `08-decisions-and-risks.md`).

## How to read these docs

| Doc | What it covers | Read it when |
| --- | --- | --- |
| [`01-critical-analysis.md`](./01-critical-analysis.md) | Feasibility critique of the original proposal | You want historical context on design tradeoffs |
| [`02-architecture.md`](./02-architecture.md) | System architecture, data flow, components | You want the big picture |
| [`03-security.md`](./03-security.md) | Trust boundaries, app token, API-level enforcement | Before writing networked/tool code |
| [`04-implementation-plan.md`](./04-implementation-plan.md) | Phased milestones and acceptance criteria | Tracking what's done vs planned |
| [`05-mcp-and-cursor-agent.md`](./05-mcp-and-cursor-agent.md) | MCP tool contracts and `cursor-agent` CLI integration | Implementing the executor layer |
| [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) | STT/TTS, Vosk wake words, Silero VAD, `/ws/intelligence` | Implementing the phone/voice layer |
| [`07-data-and-deployment.md`](./07-data-and-deployment.md) | SQLite, project registry, Tailscale, deployment | Persistence and shipping |
| [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) | Decision log (ADR-style) | You're unsure why something is the way it is |
| [`09-competitive-landscape.md`](./09-competitive-landscape.md) | Similar projects and recommendations | Build vs buy evaluation |
| [`10-cursor-cli-reference.md`](./10-cursor-cli-reference.md) | Cursor CLI reference | Debugging CLI interaction |
| [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) | Full MCP tool inventory | Implementing the MCP server |
| [`12-stream-json-watcher.md`](./12-stream-json-watcher.md) | Stream-JSON watcher and narrator | Executor + progress narration |
| [`13-voice-providers.md`](./13-voice-providers.md) | Wake words, turn submit, AWS IAM for Polly/Transcribe | Configuring voice I/O |
| [`14-prompts.md`](./14-prompts.md) | Prompts folder layout and editing | Tuning agent behavior |
| [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) | Alternate cascade workflow (STT→Claude→TTS) | Using Bedrock orchestrator mode |
| [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) | **Default** `cursor_native` workflow — Cursor as reasoning layer | Primary voice path |
| [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) | TTS interrupt snapshot, `tts_interrupt` delivery, wake-word echo filter | Barge-in bugs or agent heard/not-heard context |
| [`18-image-carousel.md`](./18-image-carousel.md) | `show_images` tool, carousel PWA, Browser snapshot workflow | UI review on phone |
| [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) | Wake Lock, silent media session, auto-resume on mobile | Screen-off disconnects on phone |
| [`20-native-callkit-shell.md`](./20-native-callkit-shell.md) | CallKit native app + push notifications | True call-style session + background alerts |
| [`21-serve-self-hosting.md`](./21-serve-self-hosting.md) | Serve hub: manual rebase/update, service logs, network | Self-hosting from Config tab |
| [`22-split-host-tunnel.md`](./22-split-host-tunnel.md) | Incus container hosting + optional SSH tunnel for Tailscale Serve | Container DNS / tunnel 502 |
| [`23-multi-agent-client.md`](./23-multi-agent-client.md) | Cursor / Codex / Claude Code CLI install, invocation flags, MCP registration | Installing or switching agent clients |
| [`24-agent-providers.md`](./24-agent-providers.md) | `AgentProvider` abstraction: phone-driven auth, live model selection, generic MCP aliases | In-app sign-in, model picker, or adding a 4th CLI |
| [`25-hosting-providers.md`](./25-hosting-providers.md) | `HostingProvider` abstraction: Tailscale, Cloudflare, ngrok, Dev Tunnels, LAN, local, manual | Choosing/switching how the bridge is exposed |
| [`26-rename-agentvoice.md`](./26-rename-agentvoice.md) | Product rename from Cursor Voice → AgentVoice (what changed / what stayed) | Migrating an existing install after the rename |

## One-paragraph summary

The **phone** (iPhone Safari PWA) captures speech with **browser STT** (WebKit or
Amazon Transcribe) and plays replies with **WebKit TTS** or **Amazon Polly**.
Utterances flow over **`/ws/intelligence`** to the bridge, which queues them for
the active coding agent (Cursor / Codex / Claude Code) via the **`cursor-voice`
MCP server** (`next_voice_turn`, `speak`, `done` — registration key kept for
compatibility; see [`26-rename-agentvoice.md`](./26-rename-agentvoice.md)). The
agent is the conversational brain; coding work is delegated to **worker** CLI
processes via `spawn_agent`. Networking defaults to **Tailscale** but is
pluggable ([`25-hosting-providers.md`](./25-hosting-providers.md)); every bridge
request is validated with a **single app token**.

## Workflows

| Workflow | Who reasons | Audio path |
| --- | --- | --- |
| **`cursor_native`** (default) | Cursor agent via MCP | PWA STT/TTS ↔ bridge ↔ MCP `speak()` |
| **`llm_intelligence`** | Claude on Bedrock Converse | Same PWA STT/TTS; bridge orchestrator |

Speech-to-speech (OpenAI Realtime, Nova Sonic) was removed. AWS IAM keys in `.env`
power **Polly**, **Transcribe**, and **Bedrock Converse** only.

## Confirmed key decisions

- **Default workflow:** `cursor_native` — Cursor controls voice via MCP.
- **Audio:** Cascade STT + TTS (not S2S). WebKit first; Amazon fallback on desktop.
- **Wake/submit:** Vosk offline grammar for wake/end phrases; Silero VAD for speech-end.
- **Safety:** Constrained MCP tool set + project allowlist + git revert.
- **Auth:** Single app token on every HTTP, WebSocket, and MCP request.
