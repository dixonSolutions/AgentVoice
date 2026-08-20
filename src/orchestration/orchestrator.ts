/**
 * The generic orchestrator: walk a chain of specializers and return the first
 * real answer.
 *
 * This is the only place fallback semantics are implemented. Before it existed
 * the speech-in and speech-out registries each had their own copy, which had
 * already started to drift — one probed availability, the other did not.
 */

import { childLogger } from '../log.js';
import {
  NoSpecializerError,
  type OrchestrationPolicy,
  type Outcome,
  type SkipRecord,
  type Specializer,
} from './types.js';

const log = childLogger('orchestration');

export interface OrchestratorOptions {
  /** Name used in logs, e.g. 'speech:input'. */
  label: string;
  /** Message when nothing in the chain could run. Gets the skip list appended. */
  emptyChainMessage: string;
}

export interface Candidate<Req, Res, Caps> {
  id: string;
  specializer: Specializer<Req, Res, Caps>;
}

/**
 * Resolve the chain to the specializers that could plausibly serve `req`.
 *
 * Exposed separately from `run` because the config UI needs the same answer
 * without sending a request — "which of these would actually be used, and why
 * not the others".
 */
export async function selectCandidates<Req, Res, Caps>(
  req: Req,
  policy: OrchestrationPolicy<Req, Res, Caps>,
): Promise<{ candidates: Array<Candidate<Req, Res, Caps>>; skipped: SkipRecord[] }> {
  const candidates: Array<Candidate<Req, Res, Caps>> = [];
  const skipped: SkipRecord[] = [];
  const seen = new Set<string>();

  for (const id of policy.chain(req)) {
    if (seen.has(id)) continue;
    seen.add(id);

    const specializer = policy.resolve(id);
    // Not an error: `browser` is a legal choice with no bridge-side handler.
    if (!specializer) continue;

    if (!specializer.isConfigured()) {
      const detail = (await specializer.checkAvailability()).detail;
      skipped.push({ id, reason: detail ?? 'not configured', phase: 'skipped' });
      continue;
    }

    const acceptance = policy.accepts(specializer, req);
    if (acceptance !== true) {
      skipped.push({ id, reason: acceptance, phase: 'skipped' });
      continue;
    }

    if (policy.probeAvailability?.(specializer)) {
      const availability = await specializer.checkAvailability();
      if (!availability.available) {
        skipped.push({ id, reason: availability.detail ?? 'unavailable', phase: 'skipped' });
        continue;
      }
    }

    candidates.push({ id, specializer });
  }

  return { candidates, skipped };
}

/**
 * Run `req` through the chain. Throws NoSpecializerError only when every
 * candidate was skipped or failed; a non-retriable failure propagates
 * immediately, because retrying it would only multiply the wait.
 */
export async function runThroughChain<Req, Res, Caps>(
  req: Req,
  policy: OrchestrationPolicy<Req, Res, Caps>,
  opts: OrchestratorOptions,
): Promise<Outcome<Res>> {
  const { candidates, skipped } = await selectCandidates(req, policy);

  if (candidates.length === 0) {
    const detail = skipped.map((s) => `${s.id}: ${s.reason}`).join('; ');
    throw new NoSpecializerError(
      skipped,
      detail ? `${opts.emptyChainMessage} — ${detail}` : opts.emptyChainMessage,
    );
  }

  const trail: SkipRecord[] = [...skipped];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const result = await candidate.specializer.handle(req);
      return { result, handledBy: candidate.id, skipped: trail };
    } catch (err) {
      lastError = err;
      const reason = err instanceof Error ? err.message : String(err);
      if (!policy.retriable(err)) throw err;
      trail.push({ id: candidate.id, reason, phase: 'failed' });
      log.warn({ subsystem: opts.label, specializer: candidate.id, err: reason },
        'specializer failed — trying the next one');
    }
  }

  throw new NoSpecializerError(
    trail,
    lastError instanceof Error ? lastError.message : opts.emptyChainMessage,
    lastError,
  );
}
