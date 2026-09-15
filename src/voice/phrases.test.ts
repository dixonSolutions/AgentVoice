/**
 * Phrase catalog (docs/39 Part B).
 *
 * The behaviours worth pinning: an `auto` event must go quiet when the voice
 * agent is already narrating (that duplicate line is the bug the catalog
 * exists to fix), raw detail must stay out of spoken text unless asked for,
 * and a template with a typo must be rejected rather than read out.
 *
 * Narration settings are passed explicitly rather than mocked — every
 * config-reading function in the catalog takes them as an optional argument.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  phrase,
  templateFor,
  validateTemplate,
  narrationModeFor,
  shouldSpeakNarration,
  narrationPayload,
  phraseCatalog,
  type NarrationSettings,
} from './phrases.js';

/** Narration settings with everything at its default. */
function settings(overrides: Partial<NarrationSettings> = {}): NarrationSettings {
  return {
    enabled: true,
    events: {},
    templates: {},
    speakRawDetail: false,
    ...overrides,
  } as NarrationSettings;
}

describe('phrase rendering', () => {
  test('fills named placeholders', () => {
    assert.equal(
      phrase('job_started', { agent: 'Codex', project: 'agentvoice' }, 'en', settings()),
      'Codex started working on agentvoice.',
    );
  });

  test('derives a plural suffix from a numeric placeholder', () => {
    const s = settings();
    assert.equal(phrase('job_done', { agent: 'Codex', count: 1 }, 'en', s), 'Done — Codex changed 1 file.');
    assert.equal(phrase('job_done', { agent: 'Codex', count: 3 }, 'en', s), 'Done — Codex changed 3 files.');
  });

  test('keeps raw provider errors out of the spoken line by default', () => {
    const spoken = phrase('job_error', { agent: 'Codex', message: 'ENOENT: /etc/shadow' }, 'en', settings());
    assert.ok(!spoken.includes('ENOENT'), spoken);
  });

  test('speaks the detail once the user opts in', () => {
    const spoken = phrase(
      'job_error',
      { agent: 'Codex', message: 'boom' },
      'en',
      settings({ speakRawDetail: true }),
    );
    assert.equal(spoken, 'Something went wrong. Codex said: boom');
  });

  test('a user override wins over the default', () => {
    const s = settings({ templates: { job_started: '{agent} is off.' } });
    assert.equal(phrase('job_started', { agent: 'Cursor', project: 'x' }, 'en', s), 'Cursor is off.');
  });

  test('a language-scoped override wins over the plain override', () => {
    const s = settings({
      templates: {
        job_done_no_changes: 'Done, nothing changed.',
        'job_done_no_changes@pl': 'Gotowe — {agent} nic nie zmienił.',
      },
    });
    assert.equal(
      phrase('job_done_no_changes', { agent: 'Codex' }, 'pl', s),
      'Gotowe — Codex nic nie zmienił.',
    );
  });

  test('a language with no override falls back rather than going silent', () => {
    const s = settings({ templates: { 'job_done_no_changes@pl': 'Gotowe.' } });
    assert.equal(
      templateFor('job_done_no_changes', 'de', s),
      'Done — {agent} finished with no file changes.',
    );
  });

  test('an empty override is ignored, not treated as silence', () => {
    const s = settings({ templates: { busy: '   ' } });
    assert.equal(phrase('busy', {}, 'en', s), "One moment — I'm still working on your last request.");
  });

  test('a missing parameter leaves the placeholder rather than printing undefined', () => {
    assert.equal(
      phrase('job_started', { agent: 'Codex' }, 'en', settings()),
      'Codex started working on {project}.',
    );
  });
});

describe('template validation', () => {
  test('accepts the placeholders the event supplies', () => {
    const result = validateTemplate('job_done', 'Changed {count} file{count_plural} — {agent}.');
    assert.equal(result.ok, true);
    assert.deepEqual(result.unknown, []);
    assert.ok(result.preview.includes('2 files'));
  });

  test('rejects a placeholder the event never supplies', () => {
    const result = validateTemplate('job_done', 'Changed {count} files in {projekt}.');
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknown, ['projekt']);
  });

  test('a template with no placeholders is fine', () => {
    assert.equal(validateTemplate('fallback_silent', 'Sorry, say that again.').ok, true);
  });
});

describe('per-event speak decisions', () => {
  test('auto stays silent when a voice agent already narrates', () => {
    assert.equal(
      shouldSpeakNarration('job_started', { agentOwnsNarration: true }, settings()),
      false,
    );
  });

  test('auto speaks when nobody else is narrating', () => {
    assert.equal(
      shouldSpeakNarration('job_started', { agentOwnsNarration: false }, settings()),
      true,
    );
  });

  test('always overrides both the master switch and agent ownership', () => {
    const s = settings({ enabled: false, events: { job_done: 'always' } });
    assert.equal(shouldSpeakNarration('job_done', { agentOwnsNarration: true }, s), true);
  });

  test('off wins over everything', () => {
    const s = settings({ events: { job_done: 'off' } });
    assert.equal(shouldSpeakNarration('job_done', { agentOwnsNarration: false }, s), false);
  });

  test('the master switch silences auto events', () => {
    const s = settings({ enabled: false });
    assert.equal(shouldSpeakNarration('job_started', { agentOwnsNarration: false }, s), false);
  });

  test('high-frequency activity events default to off', () => {
    const s = settings();
    assert.equal(narrationModeFor('file_read', s), 'off');
    assert.equal(narrationModeFor('shell_run', s), 'off');
    assert.equal(narrationModeFor('job_done', s), 'auto');
  });
});

describe('narration payload', () => {
  test('carries the event even when it will not be spoken', () => {
    const payload = narrationPayload({
      kind: 'job_done',
      text: 'Done.',
      speak: false,
      data: { count: 2 },
      jobId: 'job-1',
    });
    assert.deepEqual(payload, {
      type: 'narration',
      kind: 'job_done',
      text: 'Done.',
      speak: false,
      data: { count: 2 },
      job_id: 'job-1',
    });
  });
});

describe('catalog', () => {
  test('exposes every kind with its default wording and placeholders', () => {
    const catalog = phraseCatalog(settings());
    const jobDone = catalog.find((e) => e.kind === 'job_done');
    assert.ok(jobDone);
    assert.ok(jobDone.placeholders.includes('count'));
    assert.ok(jobDone.placeholders.includes('count_plural'));
    assert.equal(jobDone.override, null);
    // Every catalog row must be renderable, or the template editor would show
    // a row the phrase() call cannot satisfy.
    for (const entry of catalog) {
      assert.equal(validateTemplate(entry.kind, entry.default).ok, true, entry.kind);
    }
  });
});
