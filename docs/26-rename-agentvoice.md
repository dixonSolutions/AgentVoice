# 26 — Rename: Cursor Voice → AgentVoice

> Added: August 2026

## Why

The bridge now drives Cursor, Codex, and Claude Code interchangeably (see
[`24-agent-providers.md`](./24-agent-providers.md)) and exposes itself through
pluggable hosting providers beyond Tailscale (see
[`25-hosting-providers.md`](./25-hosting-providers.md)). Keeping the product
name locked to "Cursor" was misleading. **AgentVoice** is the new display /
package / service name.

## What changed

| Surface | Old | New |
| --- | --- | --- |
| Display name (PWA, CallKit, push titles, docs) | Cursor Voice | AgentVoice |
| npm package | `cursor-voice` | `agentvoice` |
| Angular project | `cursor-voice-web` | `agentvoice-web` |
| Capacitor `appName` | Cursor Voice | AgentVoice |
| Mobile package | `cursor-voice-mobile` / `@cursor-voice/call-session` | `agentvoice-mobile` / `@agentvoice/call-session` |
| systemd unit (Linux) | `cursor-voice.service` (+ `cursor-voice-watch.path`) | `agentvoice.service` (+ `agentvoice-watch.path`) |
| SSH tunnel unit | `cursor-voice-tunnel.service` | `agentvoice-tunnel.service` |
| Config dir for tunnel | `~/.config/cursor-voice/` | `~/.config/agentvoice/` |
| Prompt directory | `prompts/cursor-voice/` | `prompts/agentvoice/` |
| Nginx example | `scripts/nginx-cursor-voice.conf.example` | `scripts/nginx-agentvoice.conf.example` |
| Windows NSSM service | `CursorVoice` | `AgentVoice` |
| Example install path | `/opt/cursor-voice` | `/opt/agentvoice` |

## Stage B — the rest of the rename (August 2026)

Stage A above deliberately stopped at the display name. The deferred items were
finished in [`28-provider-parity-and-branding.md`](./28-provider-parity-and-branding.md),
each with a migration so existing installs keep working:

| Surface | Now | Migration |
| --- | --- | --- |
| MCP server registration key | `agent-voice` | every voice-session prepare strips a leftover `cursor-voice` entry, so the two can never both be registered |
| Cursor rule filename | `~/.cursor/rules/agent-voice.mdc` | the legacy `cursor-voice.mdc` body is blanked so an enabled stale rule cannot re-inject old tool names |
| MCP tool names | `agent_*` | `cursor_*` still accepted by `dispatchTool` (`LEGACY_TOOL_ALIASES`), but not advertised on the MCP server |
| `settings.voice.tts.cursorVoiceEnabled` | `agentVoiceEnabled` | rewritten on config load |
| `workflow.default: cursor_native` | `agent_native` | rewritten on config load; the admin API also accepts the old value |
| `/api/cursor-sessions/*` | `/api/agent-sessions/*` | old paths still served, so a cached PWA build keeps working |
| Internal TypeScript symbols | `agentVoicePrompt.ts`, `agentMcpSetup.ts`, `hostPaths.ts`, `agentProcess.ts`, `agentSessions.ts` | internal only |

## What deliberately did **not** change

These stay as-is so existing installs keep working without re-registering push
tokens:

| Surface | Kept as | Reason |
| --- | --- | --- |
| Capacitor / APNs `appId` / `APNS_BUNDLE_ID` | `com.cursorvoice.app` | Changing the bundle id invalidates every already-registered APNs device token |
| Android Java package | `com.cursorvoice.callsession` | Tied to the Capacitor `appId` |
| Local folder / git remote | `SideProjects/CursorVoice`, `dixonSolutions/Cursor-Voice` | Repo rename on GitHub is a manual operator step — update the remote when you're ready |

## Migration for existing hosts

### Linux (systemd user service)

```bash
# After pulling this change:
systemctl --user stop cursor-voice.service cursor-voice-watch.path 2>/dev/null || true
systemctl --user disable cursor-voice.service cursor-voice-watch.path 2>/dev/null || true
bash scripts/install-systemd.sh   # writes agentvoice.service + agentvoice-watch.path
```

### Split-host SSH tunnel

```bash
# Config dir moves; install script recreates the unit:
mv ~/.config/cursor-voice ~/.config/agentvoice 2>/dev/null || true
bash scripts/install-remote-tunnel.sh   # re-run with the same flags you used before
systemctl --user disable --now cursor-voice-tunnel.service 2>/dev/null || true
```

`scripts/ssh-remote-tunnel.sh` still accepts the legacy `CURSOR_VOICE_TUNNEL_ENV`
override as a fallback; prefer `AGENTVOICE_TUNNEL_ENV`.

### Windows

```powershell
# After pulling:
.\scripts\setup.ps1   # or manually rename the NSSM service CursorVoice → AgentVoice
```

### MCP / APNs

No action required. The APNs bundle id stays `com.cursorvoice.app`. The MCP key
became `agent-voice` in Stage B — the next voice session rewrites the entry and
removes the old `cursor-voice` one automatically.

## Repo rename (done)

GitHub repository: **`dixonSolutions/AgentVoice`** (formerly `Cursor-Voice`).
Local remotes should use:

```bash
git remote set-url origin https://github.com/dixonSolutions/AgentVoice.git
```

The local working directory name (`SideProjects/CursorVoice`) can stay; only the
git remote URL needs to match. The projects registry keeps the allowlist name
`cursorvoice` with aliases `agent voice` / `agentvoice` / `cursor voice` so
voice project selection still works either way.
