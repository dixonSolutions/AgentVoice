# Voice & agent prompts (`prompts/`)

Agent instructions are **editable markdown files**, not long strings in `config.json`.

## Layout

```
prompts/
└── agentvoice/
    ├── system.md              # Voice agent system prompt (agent_native)
    └── mcp-instructions.md    # MCP server instructions for Cursor
```

## agent_native — voice agent

| File | Loaded by | When |
| --- | --- | --- |
| `prompts/agentvoice/system.md` | `cursorVoiceRuleBody()` | First `cursor-agent` spawn only |
| `prompts/agentvoice/mcp-instructions.md` | `cursorVoiceMcpInstructions()` | MCP `/mcp` server instructions |
| `.cursor/rules/agent-voice.mdc` | Cursor rule injection | Resume spawns via `@agent-voice` |

Boot prompt lifecycle: see [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) §6.

Loader: `src/mcp/agentVoicePrompt.ts`.

## Browser / UI snapshots

When the user reviews UI on their phone or says **"Browser"**:

- Set `browser: true` on `spawn_agent` or `agent_submit` (worker takes browser snapshots).
- Brain calls `show_images` with screenshot paths from the worker summary.

See [`18-image-carousel.md`](./18-image-carousel.md).

## Related docs

- [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) — voice agent boot prompting
- [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) — `tts_interrupt` fields referenced in barge-in prompt section
