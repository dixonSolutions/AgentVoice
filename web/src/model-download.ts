/**
 * Live download progress for the offline voice models.
 *
 * Neither library reports progress. `vosk-browser`'s `createModel(url)` fetches the
 * ~50 MB archive inside its own worker, and `MicVAD.new()` fetches the ONNX graph
 * internally; both expose only a promise that settles when the work is done. On a
 * first run that leaves the user staring at a motionless orb for the length of a
 * 50 MB transfer.
 *
 * Both libraries go to the network only when the bytes are not already in Cache
 * Storage, so we fetch the assets ourselves through a counting stream, write them
 * into the caches the service worker reads from, and report progress as we go. The
 * library call that follows resolves from cache.
 *
 * A prefetch failure is never fatal: the library then downloads the asset itself,
 * silently, exactly as it did before this module existed.
 *
 * See docs/06-voice-audio-webrtc.md — Model download progress.
 */

export const VOSK_MODEL_URL = '/vosk/model.tar.gz';
export const SILERO_ASSET_BASE = '/silero-vad/';
export const SILERO_MODEL_URL = `${SILERO_ASSET_BASE}silero_vad_legacy.onnx`;
/**
 * ONNX Runtime binary that MicVAD loads. vad-web imports `onnxruntime-web/wasm`,
 * whose loader resolves this exact filename against `onnxWASMBasePath`. It is
 * 13 MB — by far the largest silent fetch after the Vosk archive.
 */
export const ORT_RUNTIME_URL = `${SILERO_ASSET_BASE}ort-wasm-simd-threaded.wasm`;

/** Must match the cache names in web/public/sw.js. */
export const VOSK_MODEL_CACHE = 'agentvoice-vosk-v1';
export const VOICE_MODEL_CACHE = 'agentvoice-models-v1';

export type ModelDownloadPhase = 'downloading' | 'unpacking';

export interface ModelDownloadState {
  phase: ModelDownloadPhase;
  /** Which asset is being fetched, e.g. "Wake-word model". */
  label: string;
  loadedBytes: number;
  /** null when the server sent no Content-Length — render an indeterminate bar. */
  totalBytes: number | null;
  /** 0–1, or null when the total is unknown. */
  fraction: number | null;
  step: number;
  stepCount: number;
}

interface ModelAsset {
  url: string;
  label: string;
  cacheName: string;
}

export interface PrefetchVoiceModelsOptions {
  /** Wake-word archive — skip when wake words are off or Vosk cannot run. */
  vosk?: boolean;
  /** Silero VAD graph — skip when turn submit does not use VAD. */
  silero?: boolean;
}

type Listener = (state: ModelDownloadState | null) => void;

const listeners = new Set<Listener>();
let currentState: ModelDownloadState | null = null;
let lastEmitAt = 0;

/** Progress arrives per network chunk; throttle so change detection is not flooded. */
const EMIT_INTERVAL_MS = 120;

/**
 * Subscribe to model download progress. The listener fires immediately with the
 * current state (null when nothing is downloading). Returns an unsubscribe fn.
 */
export function onModelDownload(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export function getModelDownloadState(): ModelDownloadState | null {
  return currentState;
}

function publish(state: ModelDownloadState | null): void {
  currentState = state;
  lastEmitAt = Date.now();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.warn('[model-download] listener failed', err);
    }
  }
}

/** Emit at most every EMIT_INTERVAL_MS; `force` bypasses it for first/last frames. */
function publishThrottled(state: ModelDownloadState, force = false): void {
  if (!force && Date.now() - lastEmitAt < EMIT_INTERVAL_MS) {
    currentState = state;
    return;
  }
  publish(state);
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function openModelCache(name: string): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(name);
  } catch (err) {
    console.warn('[model-download] Cache Storage unavailable', err);
    return null;
  }
}

/**
 * Response bodies constructed from a ReadableStream let us write to the cache
 * while counting, instead of buffering 50 MB in JS first.
 */
function canStreamResponses(): boolean {
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    void new Response(stream);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal headers for the cached copy. Dropping Vary guarantees `Cache.match`
 * hits regardless of how the library's own request is shaped.
 */
function cacheHeaders(source: Response, totalBytes: number | null): Headers {
  const headers = new Headers();
  const contentType = source.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  if (totalBytes !== null) headers.set('content-length', String(totalBytes));
  return headers;
}

async function fetchAssetIntoCache(
  asset: ModelAsset,
  step: number,
  stepCount: number,
): Promise<void> {
  const cache = await openModelCache(asset.cacheName);
  if (cache && (await cache.match(asset.url))) {
    return;
  }

  const response = await fetch(asset.url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  const totalBytes = parseContentLength(response.headers.get('content-length'));
  let loadedBytes = 0;

  const frame = (): ModelDownloadState => ({
    phase: 'downloading',
    label: asset.label,
    loadedBytes,
    totalBytes,
    fraction: totalBytes ? Math.min(1, loadedBytes / totalBytes) : null,
    step,
    stepCount,
  });

  publishThrottled(frame(), true);

  const body = response.body;
  if (!body) {
    // No streaming body — nothing to count. Drain so the HTTP cache still fills.
    await response.arrayBuffer();
    return;
  }

  const reader = body.getReader();

  if (!cache || !canStreamResponses()) {
    // Rare path: count chunks, buffer, then store in one go.
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      publishThrottled(frame());
    }
    publishThrottled(frame(), true);
    if (cache) {
      await cache.put(
        asset.url,
        new Response(new Blob(chunks as BlobPart[]), {
          headers: cacheHeaders(response, totalBytes),
        }),
      );
    }
    return;
  }

  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loadedBytes += value.byteLength;
      publishThrottled(frame());
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  await cache.put(
    asset.url,
    new Response(counted, { headers: cacheHeaders(response, totalBytes) }),
  );
  publishThrottled(frame(), true);
}

/**
 * Report the phase after the bytes have landed but before the library is ready —
 * Vosk un-tars the archive in WASM, which is several silent seconds on a phone.
 */
export function reportModelUnpacking(label: string): void {
  publish({
    phase: 'unpacking',
    label,
    loadedBytes: 0,
    totalBytes: null,
    fraction: null,
    step: 1,
    stepCount: 1,
  });
}

export function clearModelDownloadState(): void {
  if (currentState !== null) publish(null);
}

/**
 * Download the offline models into Cache Storage, reporting progress, so the
 * library calls that follow resolve locally. Safe to call repeatedly — assets
 * already cached are skipped without emitting anything.
 */
export async function prefetchVoiceModels(
  options: PrefetchVoiceModelsOptions = {},
): Promise<void> {
  const assets: ModelAsset[] = [];
  if (options.vosk !== false) {
    assets.push({
      url: VOSK_MODEL_URL,
      label: 'Wake-word model',
      cacheName: VOSK_MODEL_CACHE,
    });
  }
  if (options.silero !== false) {
    assets.push({
      url: SILERO_MODEL_URL,
      label: 'Voice activity model',
      cacheName: VOICE_MODEL_CACHE,
    });
    assets.push({
      url: ORT_RUNTIME_URL,
      label: 'Speech runtime',
      cacheName: VOICE_MODEL_CACHE,
    });
  }
  if (assets.length === 0) return;

  try {
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i]!;
      try {
        await fetchAssetIntoCache(asset, i + 1, assets.length);
      } catch (err) {
        // The library will fetch it itself — a silent download beats a failed session.
        console.warn(`[model-download] ${asset.label} prefetch failed`, err);
      }
    }
  } finally {
    clearModelDownloadState();
  }
}

/** Human-readable size for progress copy — "48.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
