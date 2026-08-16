# 15 — LLM Intelligence workflow

The **`llm_intelligence`** workflow is an **alternate** to the default **`agent_native`**
path. It uses a **cascade**: STT → Claude (Bedrock Converse) → TTS. Each layer is
independently controllable and debuggable.

For most users, **`agent_native`** is preferred — Cursor has full repo context and
controls workers directly via MCP. Use `llm_intelligence` when you want Claude as
the conversational orchestrator without Cursor IDE in the loop.

## Architecture

```
iPhone PWA (WebKit STT/TTS or Amazon fallback)
  → WebSocket /ws/intelligence
  → Claude Sonnet via Bedrock Converse (orchestrator)
  → MCP tools (cursor_* + speak / get_status / launch_agent / read_output)
  → cursor-agent CLI (actual coding)
  → stdout fed back to Claude as grounded context
  → Claude calls speak(text) → bridge → PWA TTS
```

## Configuration (`config.json`)

```json
{
  "settings": {
    "workflow": {
      "default": "llm_intelligence",
      "llmIntelligence": {
        "llm": {
          "provider": "bedrock",
          "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
          "region": "us-east-1",
          "maxTokens": 4096
        },
        "memory": {
          "maxTurns": 10,
          "keepTurns": 4,
          "summarySentences": 3
        },
        "readOutputMaxChars": 8000,
        "audio": {
          "preferWebkit": true,
          "pollyVoiceId": "Joanna",
          "pollyEngine": "neural",
          "transcribeLanguageCode": "en-US"
        }
      }
    },
    "voice": {
      "wakeWords": { "start": "cursor listen", "end": "cursor send" },
      "turnSubmit": { "silenceMs": 1500, "vadEnabled": true }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `workflow.default` | `agent_native` or `llm_intelligence` |
| `llmIntelligence.llm.model` | Bedrock Converse model (Claude 4 needs `us.anthropic.…` prefix) |
| `llmIntelligence.llm.region` | AWS region for Bedrock |
| `llmIntelligence.memory.*` | Sliding window + summarisation |
| `llmIntelligence.audio.*` | Polly/Transcribe preferences |

**Credentials:** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in `.env` (IAM keys).

## Turn flow

1. User speaks → STT → `{ type: "user_turn", text }` on `/ws/intelligence`
2. Bridge runs Bedrock orchestrator with system prompt + memory + transcript
3. Claude calls tools (`speak`, `agent_submit`, etc.) in an agentic loop
4. Bridge sends `{ type: "speak", text }` to PWA for TTS
5. `{ type: "turn_complete" }` when done → mic re-arms

## WebSocket protocol

See [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) and `src/intelligence/ws.ts`.

## Source modules

| Module | Role |
| --- | --- |
| `src/intelligence/orchestrator.ts` | Bedrock Converse agentic loop |
| `src/intelligence/ws.ts` | `/ws/intelligence` handler |
| `src/intelligence/aws/credentials.ts` | IAM auth for Bedrock |
| `src/intelligence/audio/polly.ts` | Polly TTS |
| `src/intelligence/audio/transcribe.ts` | Transcribe STT |
| `web/src/llm-intelligence-session.ts` | PWA session (shared with agent_native) |

## Related docs

- [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) — default agent_native workflow
- [`13-voice-providers.md`](./13-voice-providers.md) — wake words and AWS keys
- [`14-prompts.md`](./14-prompts.md) — orchestrator prompts
