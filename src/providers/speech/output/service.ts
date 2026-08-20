/**
 * SpeechOutputService — what the rest of the app calls to turn text into audio.
 *
 * Routes and the voice session talk to this and nothing below it.
 */

import { childLogger } from '../../../log.js';
import { runThroughChain } from '../../../orchestration/orchestrator.js';
import type { SkipRecord } from '../../../orchestration/types.js';
import type { SpeechOutputProviderId } from '../../../config.js';
import { resolveScopes, type ScopeValues } from '../../scopes.js';
import type { SpeechChainEntry } from '../input/service.js';
import {
  getSpeechOutputSpecializer,
  getSpeechOutputVendor,
  speechOutputChain,
  speechOutputPolicy,
} from './orchestrator.js';
import {
  resolveModelFor,
  resolveVoiceFor,
  scopeDefsFor,
  speechOutputLanguage,
  speechOutputSettings,
} from './settings.js';
import type { SpeechOutputResult, SpeechVoiceOption } from './types.js';

const log = childLogger('speech:output:service');

export interface SynthesizeOutcome extends SpeechOutputResult {
  provider: SpeechOutputProviderId;
  skipped: SkipRecord[];
}

/** Speak one line through the configured chain. */
export async function synthesize(
  text: string,
  opts: { language?: string; signal?: AbortSignal } = {},
): Promise<SynthesizeOutcome> {
  const language = opts.language ?? speechOutputLanguage();
  const outcome = await runThroughChain(
    {
      text,
      ...(language ? { language } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    speechOutputPolicy,
    { label: 'speech:output', emptyChainMessage: 'No text-to-speech provider is ready' },
  );

  if (outcome.skipped.length > 0) {
    log.info({ handledBy: outcome.handledBy, skipped: outcome.skipped }, 'speech output fell back');
  }

  return {
    ...outcome.result,
    provider: outcome.handledBy as SpeechOutputProviderId,
    skipped: outcome.skipped,
  };
}

/** One-shot against a specific vendor, bypassing the chain (preview button). */
export async function synthesizeWith(
  id: SpeechOutputProviderId,
  text: string,
  opts: { model?: string; voice?: string; language?: string } = {},
): Promise<SpeechOutputResult> {
  const specializer = getSpeechOutputSpecializer(id);
  if (!specializer) throw new Error('The browser voice is previewed on the device, not here.');

  const language = opts.language ?? speechOutputLanguage();
  return specializer.handle({
    text,
    ...(opts.model ? { modelOverride: opts.model } : {}),
    ...(opts.voice ? { voiceOverride: opts.voice } : {}),
    ...(language ? { language } : {}),
  });
}

/** Live voice catalog for vendors that have one; static list otherwise. */
export async function listVoices(
  id: SpeechOutputProviderId,
  model?: string,
): Promise<{ live: boolean; voices: SpeechVoiceOption[] }> {
  const vendor = getSpeechOutputVendor(id);
  if (!vendor) return { live: false, voices: [] };

  const chosen = model?.trim() || resolveSpeechOutputModel(id);
  if (!vendor.listVoices || !vendor.isConfigured()) {
    return { live: false, voices: vendor.voices(chosen) };
  }
  return { live: true, voices: await vendor.listVoices(chosen) };
}

// ── Read-only views for routes and the UI ──────────────────────────────────

export function resolveSpeechOutputModel(
  id: SpeechOutputProviderId,
  settings = speechOutputSettings(),
): string {
  const vendor = getSpeechOutputVendor(id);
  return vendor ? resolveModelFor(id, vendor.defaultModel, settings) : '';
}

export function resolveSpeechOutputVoice(
  id: SpeechOutputProviderId,
  settings = speechOutputSettings(),
  model = resolveSpeechOutputModel(id, settings),
): string {
  const vendor = getSpeechOutputVendor(id);
  return vendor ? resolveVoiceFor(id, vendor.defaultVoice(model), settings) : '';
}

export function speechOutputScopeDefs(id: SpeechOutputProviderId, model?: string) {
  const vendor = getSpeechOutputVendor(id);
  return vendor ? scopeDefsFor(vendor, model ?? resolveSpeechOutputModel(id)) : [];
}

export function resolveSpeechOutputScopes(
  id: SpeechOutputProviderId,
  settings = speechOutputSettings(),
  model = resolveSpeechOutputModel(id, settings),
): ScopeValues {
  const vendor = getSpeechOutputVendor(id);
  if (!vendor) return {};
  return resolveScopes(scopeDefsFor(vendor, model), settings.scopes[id]);
}

export function hasServerSpeechOutput(): boolean {
  try {
    return speechOutputChain().some((id) => getSpeechOutputSpecializer(id)?.isConfigured() === true);
  } catch (err) {
    log.warn({ err }, 'speech output availability check threw');
    return false;
  }
}

export function primaryServerSpeechOutputId(): SpeechOutputProviderId | null {
  for (const id of speechOutputChain()) {
    if (getSpeechOutputSpecializer(id)?.isConfigured()) return id;
  }
  return null;
}

/** The configured order as the phone needs to see it — `browser` included. */
export function describeSpeechOutputChain(settings = speechOutputSettings()): SpeechChainEntry[] {
  return speechOutputChain(settings).flatMap<SpeechChainEntry>((id) => {
    if (id === 'browser') {
      // Only the device knows which speechSynthesis voices it has.
      return [{ id, label: 'Browser TTS', device: true, ready: true }];
    }
    const specializer = getSpeechOutputSpecializer(id);
    if (!specializer) return [];
    return [{ id, label: specializer.displayName, device: false, ready: specializer.isConfigured() }];
  });
}

export { speechOutputLanguage, speechOutputSettings };
