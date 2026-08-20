# AgentVoice

_Formerly "Cursor Voice" — see [`docs/26-rename-agentvoice.md`](./docs/26-rename-agentvoice.md)._

Self-hosted voice bridge for driving a coding agent CLI —
[Cursor](https://cursor.com/docs/cli) (`cursor-agent`), [Codex](https://github.com/openai/codex),
or [Claude Code](https://github.com/anthropics/claude-code) — by **speech, from your phone**.

Speak from an iPhone **native app (CallKit)** or PWA; the active agent CLI is the reasoning
layer via the **agent-voice MCP server** (`speak`, `done`, `next_voice_turn`) — the MCP
registration key stays `agent-voice` for compatibility. Coding work is
delegated to worker agents via `spawn_agent`. **Speech is pluggable in both
directions** — listen with the browser, a **self-hosted Whisper container**
(no key, audio never leaves the host), Groq, OpenAI, Deepgram, Gemini,
ElevenLabs, OpenRouter or Amazon Transcribe; speak with the browser, a local
Kokoro voice, ElevenLabs, OpenAI, Gemini, Deepgram, Groq or Polly. Each side is
an ordered fallback chain that skips any provider which cannot handle the
language, so a device with no Polish voice hands that reply to one that has one.
Configured and keyed from Config → Speech — see
[`docs/29`](./docs/29-speech-to-text-providers.md),
[`docs/30`](./docs/30-speech-output-providers.md) and
[`docs/31`](./docs/31-service-orchestrator-converter.md).
If the CLI needs you to sign in, the app prompts you
in place — see [`docs/24-agent-providers.md`](./docs/24-agent-providers.md).

Networking defaults to Tailscale but is pluggable — Cloudflare Tunnel, ngrok,
Azure Dev Tunnels, plain LAN, or your own reverse proxy also work, one-click
from Config → Serve → Network. See
[`docs/25-hosting-providers.md`](./docs/25-hosting-providers.md).

## How it works

```
iPhone PWA (Vosk wake + STT + TTS)
        │  /ws/intelligence (app token)
        ▼
Bridge (Node/TS) ── VoiceTurnQueue ── MCP /mcp ──► Cursor voice agent
        │                                              │
        │                                              ▼ spawn_agent
        └──────────────────────────────────────► cursor-agent workers → git
```

**Default workflow:** `agent_native` — see [`docs/16-mcp-server-agent-as-brain.md`](./docs/16-mcp-server-agent-as-brain.md).

**Alternate:** `llm_intelligence` — Claude on Bedrock orchestrates tools.

## Quick start (dev)

```bash
cp config.example.json config.json
cp .env.example .env   # set APP_TOKEN + AWS IAM keys
npm install
npm run dev
```

Open the web URL shown in the terminal (unified port in test mode).

## Host on Windows (one-command setup)

Prerequisites: [Node.js 20 LTS](https://nodejs.org), [Git](https://git-scm.com), [Cursor IDE](https://cursor.com) with `cursor-agent` on PATH.

```powershell
# 1. Clone the repo
git clone https://github.com/dixonSolutions/AgentVoice.git
cd AgentVoice
# Formerly Cursor-Voice — see docs/26-rename-agentvoice.md

# 2. Run setup — installs Tailscale, builds the project, creates .env,
#    installs a Windows Service (NSSM), and configures tailscale serve.
#    Run in an elevated (Administrator) PowerShell terminal.
.\scripts\setup.ps1
```

After setup, the script prints your `APP_TOKEN`. Enter it in the PWA settings screen.

**After initial setup:**

```powershell
# Rebuild and restart after code changes
.\scripts\restart.ps1

# Diagnose connectivity issues
.\scripts\doctor.ps1
```

> **Tailscale required.** The setup script installs Tailscale via winget if it is not present.
> After installation, sign in to Tailscale and enable **HTTPS Certificates** in the
> [Tailscale admin console](https://login.tailscale.com/admin/dns) to get a trusted HTTPS URL.

## Host on Linux (one-command setup)

Prerequisites: Node.js 20 LTS, Git, Cursor IDE with `cursor-agent` on PATH.

```bash
# 1. Clone the repo
git clone https://github.com/dixonSolutions/AgentVoice.git
cd AgentVoice
# Formerly Cursor-Voice — see docs/26-rename-agentvoice.md

# 2. Run setup — installs Tailscale, builds, creates .env,
#    installs a systemd user service, and configures tailscale serve.
bash scripts/setup.sh
```

**After initial setup:**

```bash
# Rebuild and restart after code changes
bash scripts/restart.sh

# Diagnose connectivity issues
bash scripts/doctor.sh
```

**Already hosted manually?** Install the systemd user service without re-running full setup:

```bash
bash scripts/install-systemd.sh
```

**Local development vs. the production host:**

The two run on **separate ports**, so they never collide and can run side by side:

| | Command | Run profile | Bridge port |
| --- | --- | --- | --- |
| **Dev** (hot reload) | `npm run dev` | `test` (forced when `NODE_ENV=development`) | `5089` (loopback) |
| **Host** (background service) | `npm run start:service` | `serve` (from `config.json`) | `8787` (Tailscale) |

```bash
# Hot-reload dev server. Open http://localhost:4200 — /api + /ws proxy to :5089.
npm run dev

# Manage the long-running production host service (independent of dev):
npm run stop            # stop the host service + its rebuild watcher, free :8787
npm run start:service   # start the host service back up (health-checked)
```

> `config.json` → `settings.runMode` controls the **host** only. `npm run dev`
> always uses the `test` profile (port `runModes.test.backendPort`, default `5089`),
> regardless of `runMode`.

## Documentation

Full design in [`docs/`](./docs) — start with [`docs/README.md`](./docs/README.md).

| Doc | Topic |
| --- | --- |
| [`02-architecture.md`](./docs/02-architecture.md) | System architecture |
| [`06-voice-audio-webrtc.md`](./docs/06-voice-audio-webrtc.md) | STT, TTS, VAD, wake words |
| [`16-mcp-server-agent-as-brain.md`](./docs/16-mcp-server-agent-as-brain.md) | Default Cursor voice workflow |
| [`11-mcp-tool-surface.md`](./docs/11-mcp-tool-surface.md) | MCP tool inventory |
| [`20-native-callkit-shell.md`](./docs/20-native-callkit-shell.md) | CallKit native app + push notifications |
| [`23-multi-agent-client.md`](./docs/23-multi-agent-client.md) | Cursor / Codex / Claude Code CLI setup |
| [`24-agent-providers.md`](./docs/24-agent-providers.md) | In-app auth, live model selection, generic MCP tools |
| [`25-hosting-providers.md`](./docs/25-hosting-providers.md) | Tailscale, Cloudflare, ngrok, Dev Tunnels, LAN, manual |
| [`26-rename-agentvoice.md`](./docs/26-rename-agentvoice.md) | Cursor Voice → AgentVoice rename notes |

## Stack

- **Bridge:** Node.js 20+, TypeScript, Fastify, MCP SDK, SQLite
- **Web app:** Angular PWA + vanilla TS voice modules (Vosk, Silero VAD)
- **Voice I/O:** WebKit STT/TTS; Amazon Polly/Transcribe fallback
- **Reasoning:** Cursor IDE (`agent_native`) or Bedrock Claude (`llm_intelligence`)
- **Executor:** Cursor, Codex, or Claude Code CLI (`settings.agentClient`, see [`docs/24-agent-providers.md`](./docs/24-agent-providers.md))
- **Network:** Tailscale by default; Cloudflare Tunnel, ngrok, Azure Dev Tunnels, LAN, or manual (see [`docs/25-hosting-providers.md`](./docs/25-hosting-providers.md))

## Configuration

- **`.env`** — `APP_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- **`config.json`** — projects, wake words, workflow, operational settings

See [`docs/07-data-and-deployment.md`](./docs/07-data-and-deployment.md).
