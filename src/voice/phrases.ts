/**
 * Phrase catalog — every line the *bridge* speaks, in one place.
 *
 * Before this module the bridge's spoken strings were scattered across
 * `executor/watcher.ts`, `executor/narrator.ts`, `executor/voiceAgent.ts`,
 * `mcp/server/index.ts`, `routes/askpass.ts` and `intelligence/ws.ts`. Three
 * consequences, all of them user-visible:
 *
 *   1. In the agent_native workflow the voice agent narrates its own work, so
 *      the watcher's "Cursor started working on …" landed on top of the
 *      agent's own opening line. Nothing could turn just that off.
 *   2. Replies in Polish were followed by narration in English, because the
 *      strings were English literals.
 *   3. Raw provider errors and raw file paths were read out in full.
 *
 * So: one catalog, one `phrase()` call, per-kind toggles and per-kind
 * user-editable templates keyed by the speech output language.
 *
 * Templates use named placeholders only — `{agent}`, `{project}`, `{count}`.
 * A template naming a placeholder the event does not provide is rejected when
 * it is saved (`validateTemplate`) rather than read out with a `{hole}` in it.
 *
 * See docs/39-config-ui-and-narration-cleanup.md Part B.
 */

import { getConfig, type NarrationKind, type NarrationMode, type NarrationSettings } from '../config.js';
import { speechOutputLanguage } from '../providers/speech/output/settings.js';
import { childLogger } from '../log.js';

const log = childLogger('phrases');

export type { NarrationKind, NarrationMode, NarrationSettings };

/**
 * Every config-reading function here takes the narration settings as an
 * optional last argument, defaulting to the live config. Call sites pass
 * nothing; tests pass a literal. That keeps the catalog free of test hooks and
 * free of a module mock that would need an experimental Node flag.
 */
function settingsOrLive(settings?: NarrationSettings): NarrationSettings {
  return settings ?? getConfig().settings.narration;
}

export type PhraseParams = Record<string, string | number | null | undefined>;

/** Placeholders each kind is guaranteed to supply. */
export const PHRASE_PLACEHOLDERS: Record<NarrationKind, readonly string[]> = {
  job_started: ['agent', 'project'],
  job_done: ['agent', 'count'],
  job_done_no_changes: ['agent'],
  job_error: ['agent', 'message'],
  file_write: ['agent', 'path'],
  file_read: ['agent', 'path'],
  shell_run: ['agent', 'command'],
  ghost_killed: ['agent', 'reason'],
  away_replay: ['files', 'commands'],
  away_progress: ['agent', 'files'],
  permission: ['provider', 'summary'],
  secret_input: ['agent', 'prompt'],
  fallback_auth: ['provider'],
  fallback_session_gone: ['provider'],
  fallback_silent: [],
  busy: [],
};

/**
 * English defaults. A language the user has not written templates for falls
 * back to these rather than going silent.
 *
 * Deliberately shorter and less chatty than the strings they replace: the
 * watcher used to end every job with "Want to see the diff?", which is a
 * question the voice agent is better placed to ask.
 */
const DEFAULT_TEMPLATES: Record<NarrationKind, string> = {
  job_started: '{agent} started working on {project}.',
  job_done: 'Done — {agent} changed {count} file{count_plural}.',
  job_done_no_changes: 'Done — {agent} finished with no file changes.',
  job_error: 'Something went wrong while {agent} was working.',
  file_write: '{agent} wrote a file.',
  file_read: '{agent} is reading a file.',
  shell_run: '{agent} ran a command.',
  ghost_killed: 'Stopped — {agent} tried to spawn extra agents. Budget protection kicked in.',
  away_replay: 'While you were away: {files} file{files_plural} written, {commands} command{commands_plural} run.',
  away_progress: '{agent} is still working. So far: {files} file{files_plural} written.',
  permission: '{provider} wants to run {summary}. Say yes or no, or answer on your phone.',
  secret_input: '{agent} needs a password — enter it on your phone.',
  fallback_auth: '{provider} needs you to sign in — I sent a sign-in link to your phone.',
  fallback_session_gone: 'That {provider} conversation is no longer available — I started a fresh one.',
  fallback_silent: 'I finished but did not speak aloud — please try again.',
  busy: "One moment — I'm still working on your last request.",
};

/**
 * Detail-carrying variants, used only when the user has opted into hearing
 * raw paths and provider errors (`narration.speakRawDetail`).
 */
const DETAILED_TEMPLATES: Partial<Record<NarrationKind, string>> = {
  job_error: 'Something went wrong. {agent} said: {message}',
  file_write: '{agent} just wrote {path}.',
  file_read: '{agent} is reading {path}.',
  shell_run: '{agent} ran: {command}',
  ghost_killed: 'Stopped — {agent} tried to spawn extra agents ({reason}). Budget protection kicked in.',
  secret_input: '{agent} needs {prompt} — enter it on your phone.',
};

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/**
 * Placeholders every template may use regardless of kind: `{x_plural}` is
 * derived from a numeric `{x}` so a template can pluralise without the caller
 * passing two values.
 */
function withDerived(kind: NarrationKind, params: PhraseParams): PhraseParams {
  const out: PhraseParams = { ...params };
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') out[`${key}_plural`] = value === 1 ? '' : 's';
  }
  void kind;
  return out;
}

/** Names a template for `kind` is allowed to reference. */
export function allowedPlaceholders(kind: NarrationKind): string[] {
  const base = PHRASE_PLACEHOLDERS[kind] ?? [];
  return [...base, ...base.map((p) => `${p}_plural`)];
}

export interface TemplateValidation {
  ok: boolean;
  /** Placeholders in the template that this kind never supplies. */
  unknown: string[];
  /** Rendered with sample values, so the config UI can show a live preview. */
  preview: string;
}

/**
 * Validate a user-edited template. Called by the settings route before the
 * value is stored: a typo like `{aget}` must be a save error, not something
 * the user hears their phone read out.
 */
export function validateTemplate(kind: NarrationKind, template: string): TemplateValidation {
  const allowed = new Set(allowedPlaceholders(kind));
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name && !allowed.has(name)) unknown.push(name);
  }
  const sample: PhraseParams = {};
  for (const name of PHRASE_PLACEHOLDERS[kind] ?? []) {
    sample[name] = name === 'count' || name === 'files' || name === 'commands' ? 2 : `«${name}»`;
  }
  return {
    ok: unknown.length === 0,
    unknown: [...new Set(unknown)],
    preview: render(template, withDerived(kind, sample)),
  };
}

function render(template: string, params: PhraseParams): string {
  return template
    .replace(PLACEHOLDER_RE, (whole, name: string) => {
      const value = params[name];
      if (value === undefined || value === null) return whole;
      return String(value);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Template lookup order: a user override for the current speech language, a
 * user override with no language suffix, the detailed default when raw detail
 * is allowed, then the plain English default.
 *
 * Overrides are keyed `kind` or `kind@lang` (e.g. `job_done@pl`) in
 * `settings.narration.templates`, so one field per language needs no schema
 * change.
 */
export function templateFor(
  kind: NarrationKind,
  lang?: string,
  settings?: NarrationSettings,
): string {
  const narration = settingsOrLive(settings);
  const language = lang ?? speechOutputLanguage();
  const overrides = narration.templates as Record<string, string | undefined>;
  if (language) {
    const scoped = overrides[`${kind}@${language}`];
    if (scoped && scoped.trim()) return scoped;
  }
  const plain = overrides[kind];
  if (plain && plain.trim()) return plain;
  if (narration.speakRawDetail) {
    const detailed = DETAILED_TEMPLATES[kind];
    if (detailed) return detailed;
  }
  return DEFAULT_TEMPLATES[kind];
}

/** Render one spoken line. Never throws — narration must not break a job. */
export function phrase(
  kind: NarrationKind,
  params: PhraseParams = {},
  lang?: string,
  settings?: NarrationSettings,
): string {
  try {
    return render(templateFor(kind, lang, settings), withDerived(kind, params));
  } catch (err) {
    log.warn({ err, kind }, 'phrase render failed — falling back to the default template');
    return render(DEFAULT_TEMPLATES[kind], withDerived(kind, params));
  }
}

// ── Per-event toggles ───────────────────────────────────────────────────────

/**
 * `auto` means "speak only if nobody else is narrating".
 *
 * In agent_native the voice agent is told, in its own prompt, to speak before
 * spawning a worker, on each milestone and at the end. Any bridge line on top
 * of that is a duplicate. In llm_intelligence — or in agent_native with no
 * agent attached — there is nobody to narrate, so the bridge should.
 */
/**
 * Per-kind default. Everything is `auto` except the three high-frequency
 * activity events: one spoken line per file read or shell command would bury
 * the agent's own replies, so they are recorded (and counted in the away
 * digest) but silent until the user asks for them.
 */
const DEFAULT_MODES: Partial<Record<NarrationKind, NarrationMode>> = {
  file_read: 'off',
  shell_run: 'off',
};

export function narrationModeFor(kind: NarrationKind, settings?: NarrationSettings): NarrationMode {
  const narration = settingsOrLive(settings);
  const events = narration.events as Partial<Record<NarrationKind, NarrationMode>>;
  return events[kind] ?? DEFAULT_MODES[kind] ?? 'auto';
}

export interface SpeakDecisionContext {
  /** True when a voice agent is attached and owns spoken narration. */
  agentOwnsNarration: boolean;
}

/**
 * Whether this event should be spoken aloud. The event itself is always
 * delivered — see `narrationPayload` — so push notifications and the orb's
 * working state keep working with narration switched off entirely.
 */
export function shouldSpeakNarration(
  kind: NarrationKind,
  ctx: SpeakDecisionContext,
  settings?: NarrationSettings,
): boolean {
  const narration = settingsOrLive(settings);
  const mode = narrationModeFor(kind, narration);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (!narration.enabled) return false;
  return !ctx.agentOwnsNarration;
}

/**
 * Build the wire payload for a narration event.
 *
 * `speak` is carried separately from the text so that turning narration off
 * silences the phone without also killing the `job_done` push notification and
 * the `notifyJobRunning` state the PWA derives from the same message — which
 * is exactly what the single `narratorEnabled` switch used to do.
 */
export function narrationPayload(params: {
  kind: NarrationKind;
  text: string;
  speak: boolean;
  data?: Record<string, unknown>;
  jobId?: string | null;
}): Record<string, unknown> {
  return {
    type: 'narration',
    kind: params.kind,
    text: params.text,
    speak: params.speak,
    data: params.data ?? {},
    ...(params.jobId ? { job_id: params.jobId } : {}),
  };
}

/** The catalog, for the config UI's template editor. */
export function phraseCatalog(settings?: NarrationSettings): Array<{
  kind: NarrationKind;
  default: string;
  detailed: string | null;
  placeholders: string[];
  mode: NarrationMode;
  override: string | null;
}> {
  const narration = settingsOrLive(settings);
  const overrides = narration.templates as Record<string, string | undefined>;
  return (Object.keys(DEFAULT_TEMPLATES) as NarrationKind[]).map((kind) => ({
    kind,
    default: DEFAULT_TEMPLATES[kind],
    detailed: DETAILED_TEMPLATES[kind] ?? null,
    placeholders: allowedPlaceholders(kind),
    mode: narrationModeFor(kind, narration),
    override: overrides[kind] ?? null,
  }));
}
