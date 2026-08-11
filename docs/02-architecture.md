# 02 — Architecture

## Components

| Component | Tech | Responsibility |
| --- | --- | --- |
| **Phone PWA** | Angular + vanilla TS modules | Mic capture, Vosk wake words, Silero VAD, STT, TTS playback, orb UI |
| **Bridge** | Node 20+, TypeScript, Fastify | Serves PWA, `/ws/intelligence`, MCP HTTP server, spawns voice + worker agents, SQLite state |
| **MCP server** | `@modelcontextprotocol/sdk` | Voice I/O (`speak`, `done`, `next_voice_turn`) + agent control tools |
| **Voice agent** | `cursor-agent -p` / `codex exec` / `claude -p` | Conversational loop for `cursor_native`; calls MCP voice tools |
| **Worker agents** | Same as voice agent | Coding tasks spawned via `spawn_agent` |
| **Agent client** | `cursor` (default) \| `codex` \| `claude-code` | Selectable via `config.json` `agentClient` or PWA config tab; see [docs/23-multi-agent-client.md](./23-multi-agent-client.md) |
| **AWS (optional)** | Polly, Transcribe, Bedrock Converse | TTS/STT fallback and `llm_intelligence` orchestrator |
| **Network** | Tailscale (`serve`) | Private mesh + HTTPS for mic access |
| **State** | SQLite | Jobs, voice agent runs, project registry, audit log |

## Trust boundaries

```
[ iPhone PWA ]
    |  STT text, TTS audio (local or Polly)
    |  WSS /ws/intelligence (app token)
    v
[ Bridge ]
    |  VoiceTurnQueue (pull-based turns)
    |  MCP /mcp (Bearer token)
    v
[ Cursor IDE — voice agent ]
    |  spawn_agent / cursor_* tools
    v
[ cursor-agent workers ] --> [ allowlisted project workspaces ] --> git
```

- **Audio reasoning** happens in Cursor (`cursor_native`) or Bedrock Claude (`llm_intelligence`).
- **Tool execution** never happens on the phone.
- **AWS IAM keys** stay on the bridge — Polly/Transcribe audio is proxied via `/api/intelligence/*`.

## End-to-end sequence (`cursor_native`)

```
User taps orb → PWA opens /ws/intelligence
  │
User says wake phrase → Vosk activates → STT captures utterance
  │
PWA → Bridge: { type: "user_turn", text }
  │
Bridge enqueues turn in VoiceTurnQueue
Bridge auto-spawns cursor-agent (voice loop) if not running
  │
Cursor MCP: next_voice_turn() → dequeued text
Cursor reasons → speak("…") → bridge → PWA TTS
Cursor → spawn_agent(instructions) for coding work
Cursor → done() → bridge → { type: "turn_complete" } → mic re-arms
  │
Loop: next_voice_turn() again
```

## Voice agent boot prompting

| Spawn | Prompt passed to `cursor-agent -p` |
| --- | --- |
| **First session** (no `--resume`) | Full system prompt from `prompts/agentvoice/system.md` + boot suffix |
| **Resume** (`--resume <id>`) | `@cursor-voice` rule reference + short boot line |

On resume, Cursor injects the rule from `~/.cursor/rules/cursor-voice.mdc` (or project
`.cursor/rules/`). Conversation history is preserved via `--resume`; the full system
prompt is not resent.

Implementation: `src/executor/voiceAgent.ts` — `buildVoiceBootPrompt(project)`.

## Process & module layout

```
agentvoice/
├── docs/
├── prompts/
│   └── agentvoice/            # Voice agent system + MCP instructions
├── src/
│   ├── server.ts              # Fastify: PWA, /api, /ws/intelligence, /mcp
│   ├── config.ts              # .env + config.json (zod)
│   ├── executor/
│   │   ├── voiceAgent.ts      # Auto-spawn conversational cursor-agent
│   │   ├── jobManager.ts      # Worker agent jobs
│   │   └── watcher.ts         # stream-json parser
│   ├── intelligence/            # llm_intelligence orchestrator + AWS audio
│   ├── mcp/server/            # MCP tool handlers + turn queue
│   ├── voice/                 # Wake words config, TTS interrupt types
│   └── state/                 # SQLite, registry, jobs
├── web/                       # Angular PWA + vanilla TS voice modules
│   ├── llm-intelligence-session.ts  # Shared session for both workflows
│   ├── silero-vad.ts, vosk-wake-word.ts, amazon-tts.ts, amazon-stt.ts
│   └── src/app/               # Angular UI (voice tab, config tab)
└── config.example.json
```

## State machine (PWA orb)

```
        tap orb
 idle ─────────► inactive ── wake phrase ──► listening ──► working
   ▲                  │                              │           │
   └──── tap orb (hang up) ─────────────────────────┴───────────┘
```

- **inactive:** session open, waiting for wake phrase (Vosk).
- **listening:** utterance capture (STT + VAD or end phrase).
- **working:** Cursor thinking or worker agent running.

## Latency budget

| Hop | Target |
| --- | --- |
| Wake phrase → Vosk detect | ~100–300 ms (offline) |
| Speech end → turn submit | VAD or silence timer |
| Turn → first `speak()` | Cursor-bound |
| `spawn_agent` work | seconds–minutes (narrated progress) |

UX strategy: one sentence per `speak()` call; TTS barge-in via wake phrase during playback.
