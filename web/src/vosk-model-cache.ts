/** Shared Vosk model — loaded once, reused for start/end grammar spotters. */

import type { Model } from 'vosk-browser';
import {
  VOSK_MODEL_URL,
  clearModelDownloadState,
  prefetchVoiceModels,
  reportModelUnpacking,
} from './model-download.js';

let modelPromise: Promise<Model> | null = null;

/**
 * Confirm the bridge is serving a real gzip archive, not the SPA fallback
 * (index.html) it returns while the model is still being prepared. Handing an
 * HTML page to createModel() makes it try to untar HTML and hang forever, so we
 * fail fast instead — the caller retries once the bridge reports the model
 * ready over the socket.
 */
async function assertModelReady(): Promise<void> {
  const res = await fetch(VOSK_MODEL_URL, { credentials: 'same-origin' });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  try {
    void res.body?.cancel();
  } catch {
    /* ignore */
  }
  if (!res.ok || contentType.includes('text/html')) {
    throw new Error('wake-word model is not ready on the bridge yet');
  }
}

export function loadVoskModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (async () => {
      // Fail fast if the bridge is still preparing the model, so we never hand
      // createModel() an HTML error page (which would untar forever).
      await assertModelReady();
      // Pull the archive with progress first; createModel() then reads it from
      // Cache Storage instead of doing a silent 50 MB fetch inside its worker.
      await prefetchVoiceModels({ vosk: true, silero: false });

      const m = await import('vosk-browser');
      // esbuild bundles CJS modules as a default export only (`export default JU()`).
      // The named export `createModel` lives on `.default` in the bundled chunk,
      // but on the module namespace directly in Node / un-bundled ESM.
      // Fall back gracefully so the same code works in both environments.
      const mod = m as Record<string, unknown> & {
        createModel?: (url: string) => Promise<Model>;
        default?: { createModel?: (url: string) => Promise<Model> };
      };
      const createModel = mod.createModel ?? mod.default?.createModel;
      if (typeof createModel !== 'function') {
        throw new Error(
          'vosk-browser: createModel not found — check bundle output (CJS/ESM mismatch).',
        );
      }

      // The archive is un-tarred in WASM after download — seconds on a phone,
      // with nothing to count. Say so rather than freezing a full progress bar.
      reportModelUnpacking('Wake-word model');
      try {
        return await createModel(VOSK_MODEL_URL);
      } finally {
        clearModelDownloadState();
      }
    })().catch((err: unknown) => {
      // Let the next caller retry instead of caching the rejection forever.
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

export function clearVoskModelCache(): void {
  modelPromise = null;
}
