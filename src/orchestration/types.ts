/**
 * The four roles every pluggable subsystem here is built from.
 *
 *   Service       what the rest of the app calls. Neutral vocabulary, no vendors.
 *   Orchestrator  decides *who* handles a request: chain order, capability
 *                 checks, fallback on failure. All policy, no vendor knowledge.
 *   Converter     translates neutral request → one vendor's native call, and
 *                 that vendor's native response → neutral result. The
 *                 anti-corruption layer: vendor field names stop here.
 *   Specializer   one vendor. Owns transport, credentials, and the capability
 *                 declaration the orchestrator reasons about. Delegates payload
 *                 shaping to its converter.
 *
 * The point of the split is that each layer has exactly one reason to change:
 * a new vendor is a converter plus a specializer; a new *policy* (prefer
 * cheapest, prefer local, round-robin) is an orchestrator change that touches
 * no vendor; and a new caller talks to the service without learning either.
 *
 * Three subsystems share it — speech in, speech out, and the coding-agent CLIs.
 * They have nothing in common at the payload level, which is precisely why the
 * shared part has to be this thin.
 *
 * See docs/31-service-orchestrator-converter.md.
 */

/** Result of asking a specializer whether it can work right now. */
export interface Availability {
  available: boolean;
  /** Short reason when unavailable — surfaced verbatim in the UI. */
  detail?: string;
}

/**
 * Why a specializer was passed over. Kept structured rather than logged and
 * dropped, because "why did it not use the one I picked?" is the single most
 * common question a fallback chain provokes.
 */
export interface SkipRecord {
  id: string;
  reason: string;
  /** `skipped` = never attempted; `failed` = attempted and errored. */
  phase: 'skipped' | 'failed';
}

/**
 * Whether a specializer can serve a specific request — beyond being merely
 * configured. Returning a string means "no, and here is why", which becomes
 * the SkipRecord reason.
 */
export type Acceptance = true | string;

export interface Specializer<Req, Res, Caps = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** What the orchestrator reasons about. Shape is per-subsystem. */
  readonly capabilities: Caps;

  /** Cheap, synchronous, side-effect-free: are credentials/config present? */
  isConfigured(): boolean;

  /** May touch the network (a self-hosted health check). Keep it short. */
  checkAvailability(): Promise<Availability>;

  /** Convert, send, convert back. The only method that knows a wire format. */
  handle(req: Req): Promise<Res>;
}

/**
 * Translates between the neutral domain model and one vendor's shapes.
 *
 * `Native` is deliberately open: an HTTP call for the speech providers, an
 * argv + env pair for the agent CLIs.
 */
export interface Converter<Req, Res, NativeReq, NativeRes> {
  readonly id: string;
  encode(req: Req): NativeReq | Promise<NativeReq>;
  decode(native: NativeRes, req: Req): Res | Promise<Res>;
}

/**
 * The policy an orchestrator applies. Everything here is about *choosing*,
 * never about talking to a vendor.
 */
export interface OrchestrationPolicy<Req, Res, Caps = unknown> {
  /** Ordered specializer ids to consider for this request. */
  chain(req: Req): string[];
  /** Look up a specializer by id, or null when the id has no implementation. */
  resolve(id: string): Specializer<Req, Res, Caps> | null;
  /**
   * Can this specializer serve this particular request? Configuration is
   * already checked by the orchestrator — this is for request-shaped limits
   * such as "cannot speak Ukrainian".
   */
  accepts(specializer: Specializer<Req, Res, Caps>, req: Req): Acceptance;
  /**
   * Is it worth trying the next specializer after this failure? Bad input
   * fails identically everywhere; credentials and reachability do not.
   */
  retriable(err: unknown): boolean;
  /**
   * Consult checkAvailability() before attempting. Costs a round trip, so it
   * is opt-in — worth it for self-hosted servers, wasteful for API keys.
   */
  probeAvailability?(specializer: Specializer<Req, Res, Caps>): boolean;
}

export interface Outcome<Res> {
  result: Res;
  /** Which specializer actually answered. */
  handledBy: string;
  /** Everyone passed over or tried first, in order. */
  skipped: SkipRecord[];
}

/** Thrown when every candidate in the chain was skipped or failed. */
export class NoSpecializerError extends Error {
  constructor(
    readonly skipped: SkipRecord[],
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NoSpecializerError';
  }
}
