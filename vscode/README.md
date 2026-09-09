# AgentVoice for VS Code and Cursor

A desk client for the [AgentVoice](https://github.com/dixonSolutions/AgentVoice) bridge.
The phone app is for hands-free; this is for the other half of the day, when you
are at the editor and the same agent session should follow you there.

- **Approvals in the editor** — Claude Code permission prompts, the agent's
  questions, plan reviews and `sudo` / `git` / `ssh` password prompts appear as
  notifications and as cards in the panel. Whoever answers first (phone or
  editor) wins.
- **Send context** — selection, active file, or the file's diagnostics, with
  path and line range, as a turn to the agent (`Ctrl+Alt+A` / `Ctrl+Alt+Shift+A`).
- **Read-along panel** — the agent's spoken lines appear as a page of text: read
  text bright, unread dim, the current word highlighted. Voice is optional
  (bridge TTS, editor voices, or silent pacing).
- **Edits and diffs** — files the agent writes show up in *Changes*; click to
  open the native diff against `HEAD`. Revert stashes the working tree.
- **Project = this folder** — the open workspace becomes the active project
  without editing `config.json`.
- **Model, effort, permission mode, sessions** — all live from the bridge,
  which reads them from the active CLI (Cursor, Codex, Claude Code, Codewhale).

## Setup

1. Run the bridge on this machine (`npm start` or the systemd unit).
2. Install the extension from the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=dixonsolutions.agentvoice)
   or [Open VSX](https://open-vsx.org/extension/dixonsolutions/agentvoice):
   `code --install-extension dixonsolutions.agentvoice` (Cursor and VSCodium
   take the same id from Open VSX). To run an unreleased build instead:
   `npm run build:vscode` at the repo root, then
   `code --install-extension vscode/agentvoice.vsix`.
3. Set `agentvoice.bridgeUrl` if the bridge is not on `http://127.0.0.1:8787`
   (the dev bridge is on `5089`).
4. Run **AgentVoice: Set bridge token** and paste `APP_TOKEN` from the bridge `.env`.

Design notes, protocol and limits: `docs/34-vscode-extension.md` in the repo.
