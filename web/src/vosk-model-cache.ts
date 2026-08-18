/** Shared Vosk model — loaded once, reused for start/end grammar spotters. */

import type { Model } from 'vosk-browser';
import {
  VOSK_MODEL_URL,
  clearModelDownloadState,
  prefetchVoiceModels,
  reportModelUnpacking,
} from './model-download.js';

let modelPromise: Promise<Model> | null = null;

export function loadVoskModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (async () => {
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
