/**
 * HTTP transport for specializers whose vendor speaks REST.
 *
 * `createHttpSpecializer` reduces a vendor to a converter plus a metadata
 * block: encode the neutral request into one HTTP call, decode the response
 * back. Auth, timeouts, error classification and the Specializer contract are
 * handled here, so a new REST provider is genuinely one small file.
 *
 * Node 20+ globals only (fetch / FormData / Blob) — no SDK per vendor, which
 * keeps the dependency surface flat and the failure modes uniform.
 */

import type { Availability, Converter, Specializer } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly provider: string,
  ) {
    super(detail);
    this.name = 'ProviderHttpError';
  }

  /** 401/403 — the credential itself is wrong, not the request. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * Worth handing to the next specializer? Credentials, quota, reachability
   * and unknown-model all say yes; a malformed request says no, since it would
   * be just as malformed everywhere else.
   */
  get isRetriable(): boolean {
    return this.isAuthError || this.status === 429 || this.status === 404 || this.status >= 500;
  }
}

/** One vendor call, as produced by a converter. */
export interface HttpCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** `RequestInit['body']` — Node's fetch types do not export BodyInit globally. */
  body?: RequestInit['body'];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type HttpConverter<Req, Res> = Converter<Req, Res, HttpCall, Response>;

/** Pull the most useful message out of a vendor error body (JSON or text). */
export async function readErrorDetail(res: Response): Promise<string> {
  const fallback = `${res.status} ${res.statusText}`.trim();
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return fallback;
  }
  if (!raw.trim()) return fallback;

  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const candidates = [
      (body['error'] as { message?: string } | undefined)?.message,
      typeof body['error'] === 'string' ? (body['error'] as string) : undefined,
      body['message'] as string | undefined,
      typeof body['detail'] === 'string' ? (body['detail'] as string) : undefined,
      body['err_msg'] as string | undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // not JSON — fall through to the raw text
  }

  return raw.length > 300 ? `${raw.slice(0, 297)}…` : raw.trim();
}

/** fetch with a hard timeout, chained onto any caller-supplied abort signal. */
export async function httpFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

export async function expectOk(res: Response, provider: string): Promise<Response> {
  if (res.ok) return res;
  throw new ProviderHttpError(res.status, await readErrorDetail(res), provider);
}

export interface HttpSpecializerSpec<Req, Res, Caps> {
  id: string;
  displayName: string;
  description: string;
  capabilities: Caps;
  converter: HttpConverter<Req, Res>;
  isConfigured(): boolean;
  /** Defaults to "configured means available" — override for self-hosted. */
  checkAvailability?(): Promise<Availability>;
  /** Message when `isConfigured()` is false, e.g. "GROQ_API_KEY is not set". */
  unconfiguredDetail?: string;
}

export function createHttpSpecializer<Req, Res, Caps>(
  spec: HttpSpecializerSpec<Req, Res, Caps>,
): Specializer<Req, Res, Caps> {
  return {
    id: spec.id,
    displayName: spec.displayName,
    description: spec.description,
    capabilities: spec.capabilities,
    isConfigured: spec.isConfigured,

    async checkAvailability(): Promise<Availability> {
      if (spec.checkAvailability) return spec.checkAvailability();
      return spec.isConfigured()
        ? { available: true }
        : { available: false, ...(spec.unconfiguredDetail ? { detail: spec.unconfiguredDetail } : {}) };
    },

    async handle(req: Req): Promise<Res> {
      const call = await spec.converter.encode(req);
      const res = await httpFetch(
        call.url,
        {
          method: call.method ?? 'POST',
          ...(call.headers ? { headers: call.headers } : {}),
          ...(call.body !== undefined ? { body: call.body } : {}),
        },
        {
          ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      await expectOk(res, spec.id);
      return spec.converter.decode(res, req);
    },
  };
}
