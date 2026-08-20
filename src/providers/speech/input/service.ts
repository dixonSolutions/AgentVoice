/**
 * SpeechInputService — what the rest of the app calls to turn audio into text.
 *
 * Routes and the voice session talk to this and nothing below it. They never
 * learn which vendor answered unless they ask, which is what makes swapping
 * engines a settings change rather than a code change.
 */

import { childLogger } from '../../../log.js';
import { runThroughChain } from '../../../orchestration/orchestrator.js';
import type { SkipRecord } from '../../../orchestration/types.js';
import type { SpeechInputProviderId } from '../../../config.js';
import { resolveScopes, type ScopeValues } from '../../scopes.js';
import { baseLanguage } from '../languages.js';
import {
  getSpeechInputSpecializer,
  getSpeechInputVendor,
  speechInputChain,
  speechInputPolicy,
} from './orchestrator.js';
import { resolveModelFor, scopeDefsFor, speechInputSettings } from './settings.js';
import type { SpeechInputRequest, SpeechInputResult } from './types.js';

const log = childLogger('speech:input:service');

export interface TranscribeOutcome extends SpeechInputResult {
  /** Which vendor answered. */
  provider: SpeechInputProviderId;
  /** Everyone passed over or tried first — the answer to "why not the one I picked?". */
  skipped: SkipRecord[];
}

/**
 * Transcribe one utterance through the configured chain.
 *
 * An empty transcript is a legitimate result (silence), not an error. Throws
 * only when every candidate was skipped or failed.
 */
export async function transcribe(
  pcm: Buffer,
  opts: { signal?: AbortSignal; language?: string } = {},
): Promise<TranscribeOutcome> {
  const settings = speechInputSettings();
  const req: SpeechInputRequest = {
    pcm,
    ...(opts.language ?? baseLanguage(settings.language)
      ? { language: opts.language ?? baseLanguage(settings.language) ?? undefined }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const outcome = await runThroughChain(req, speechInputPolicy, {
    label: 'speech:input',
    emptyChainMessage: 'No speech-to-text provider is ready',
  });

  if (outcome.skipped.length > 0) {
    log.info({ handledBy: outcome.handledBy, skipped: outcome.skipped }, 'speech input fell back');
  }

  return {
    ...outcome.result,
    provider: outcome.handledBy as SpeechInputProviderId,
    skipped: outcome.skipped,
  };
}

/**
 * One-shot against a specific vendor, bypassing the chain. Used by the
 * "test provider" button, where the point is to exercise the one you picked.
 */
export async function transcribeWith(
  id: SpeechInputProviderId,
  pcm: Buffer,
  opts: { model?: string; language?: string } = {},
): Promise<SpeechInputResult> {
  const specializer = getSpeechInputSpecializer(id);
  if (!specializer) throw new Error(`${id} runs on the phone — there is nothing to call here.`);

  return specializer.handle({
    pcm,
    ...(opts.model ? { modelOverride: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
}

// ── Read-only views for routes and the UI ──────────────────────────────────

export function resolveSpeechInputModel(
  id: SpeechInputProviderId,
  settings = speechInputSettings(),
): string {
  const vendor = getSpeechInputVendor(id);
  return vendor ? resolveModelFor(id, vendor.defaultModel, settings) : '';
}

export function resolveSpeechInputScopes(
  id: SpeechInputProviderId,
  settings = speechInputSettings(),
  model = resolveSpeechInputModel(id, settings),
): ScopeValues {
  const vendor = getSpeechInputVendor(id);
  if (!vendor) return {};
  return resolveScopes(scopeDefsFor(vendor, model), settings.scopes[id]);
}

export function speechInputScopeDefs(id: SpeechInputProviderId, model?: string) {
  const vendor = getSpeechInputVendor(id);
  return vendor ? scopeDefsFor(vendor, model ?? resolveSpeechInputModel(id)) : [];
}

/** True when at least one server-side candidate could answer right now. */
export function hasServerSpeechInput(): boolean {
  try {
    return speechInputChain().some((id) => getSpeechInputSpecializer(id)?.isConfigured() === true);
  } catch (err) {
    log.warn({ err }, 'speech input availability check threw');
    return false;
  }
}

/** First server-side candidate that is configured — what the phone will hit. */
export function primaryServerSpeechInputId(): SpeechInputProviderId | null {
  for (const id of speechInputChain()) {
    if (getSpeechInputSpecializer(id)?.isConfigured()) return id;
  }
  return null;
}

/** One step of the configured chain, as the phone sees it. */
export interface SpeechChainEntry {
  id: string;
  label: string;
  /** Runs in the PWA rather than on the bridge. */
  device: boolean;
  /** Bridge-side readiness. Always true for device entries — the phone decides. */
  ready: boolean;
}

/**
 * The configured order as the phone needs to see it — `browser` included.
 *
 * The PWA walks this and takes the first entry it can actually use, so
 * "browser first, Groq when the browser can't" is expressed once, in settings,
 * rather than duplicated as client-side precedence rules.
 */
export function describeSpeechInputChain(settings = speechInputSettings()): SpeechChainEntry[] {
  return speechInputChain(settings).flatMap<SpeechChainEntry>((id) => {
    if (id === 'browser') {
      // Only the device knows whether SpeechRecognition works here.
      return [{ id, label: 'Browser STT', device: true, ready: true }];
    }
    const specializer = getSpeechInputSpecializer(id);
    if (!specializer) return [];
    return [{ id, label: specializer.displayName, device: false, ready: specializer.isConfigured() }];
  });
}
