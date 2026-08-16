/**
 * The one place the app's own identity is written down.
 *
 * Two distinct identities used to be muddled together across the UI:
 *
 *   - THIS APP — "AgentVoice". Its name and mark belong in exactly one place
 *     on screen (the top bar), rendered by <cv-brand>. It was previously
 *     spelled out again in the token dialog, in a separate <p-tag> beside the
 *     logo, and in scattered string literals, so a rename meant hunting.
 *
 *   - THE CODING AGENT — Cursor / Codex / Claude Code. That name is *runtime*
 *     state, never a constant: it comes from AgentProviderService and is shown
 *     in one chip plus the session log. Hardcoding "Cursor" there told a Claude
 *     Code user the wrong thing on every line.
 *
 * Colour is deliberately absent. The orb and every accent follow the app theme
 * (Config → Appearance tone → Optimus `--p-primary-*`). Agent-provider brand
 * colours are never applied — the UI must not change hue because the user
 * switched CLI.
 */

export const APP_NAME = 'AgentVoice';

/** PWA icon in /public — also the favicon and the mark in <cv-brand>. */
export const APP_ICON_SRC = '/icon.svg';

/** Fallback used before the provider list has loaded. Deliberately neutral. */
export const FALLBACK_AGENT_NAME = 'the coding agent';
