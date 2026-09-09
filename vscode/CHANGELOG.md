# Changelog

All notable changes to the AgentVoice extension for VS Code and Cursor.
Releases are tagged `vscode-vX.Y.Z` in the
[AgentVoice repository](https://github.com/dixonSolutions/AgentVoice).

## 0.1.2

- Fix the composer in the **Agent** panel. Its placeholder was longer than the
  two rows it was given, so it rendered clipped mid-sentence next to a resize
  grabber and a scrollbar — most of a field that is only about 180px wide in a
  sidebar. It now starts one line tall, grows with what you type up to 40vh,
  and carries the Enter / Shift+Enter hint in its tooltip.

## 0.1.1

- Ship the real AgentVoice mark. The gallery icon is now generated from the
  same authoritative `web/public/icon.svg` the PWA uses (via
  `scripts/gen-icons.mjs`), instead of a stand-in drawn for the first release,
  and the activity-bar icon is that mark's silhouette rather than a generic
  microphone. Adds a gallery banner in the product's `#1a1a2e`.

## 0.1.0

First release.

- Status bar item: active agent, model / effort / fast, project, pending-approval badge, running jobs; click for a menu.
- **Agent** panel: read-along transcript of the agent's spoken lines (read text bright, unread dim, current word underlined; silent pacer, bridge text-to-speech or editor voices), approval cards, activity feed, composer.
- **Changes** view: files the agent wrote this session, native diff against `HEAD`, full patch, revert via `git stash`.
- **Agents, jobs & sessions** view: conversational agent, worker jobs, recent history, resumable CLI threads.
- Commands: send selection / active file / file diagnostics / free prompt as a turn; use this workspace as the project; pick project, model + effort + fast, permission mode; new session; stop; answer pending approval.
- Notifications for permission prompts, questions, plan reviews and masked password prompts; first answer wins across phone and editor.
- Works with every bridge provider (Cursor, Codex, Claude Code, Codewhale) through the bridge's `/ws/events` socket and REST routes; nothing CLI-specific in the extension.
