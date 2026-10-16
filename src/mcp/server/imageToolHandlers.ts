/**
 * show_images — push an image carousel to the connected PWA (non-blocking).
 */

import { childLogger } from '../../log.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { ShowImagesSchema } from '../schemas.js';
import { setImages, DEFAULT_BATCH_TTL_MS, resolveAllowedImagePath } from './imageRegistry.js';
import { publishAgentFiles } from './fileToolHandlers.js';

const log = childLogger('mcp:server:imageTools');

export interface ShowImagesResult {
  ok: boolean;
  count: number;
  delivered: boolean;
  batch_id?: string;
  error?: string;
}

export function handleShowImages(args: unknown): ShowImagesResult {
  const parsed = ShowImagesSchema.safeParse(args);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join('; ');
    return { ok: false, count: 0, delivered: false, error: message };
  }

  const { images, duration_ms, caption, publish } = parsed.data;
  const durationMs = duration_ms ?? 8000;

  try {
    const { batchId, images: carouselImages } = setImages(images, DEFAULT_BATCH_TTL_MS);

    const payload = {
      type: 'show_images' as const,
      batch_id: batchId,
      images: carouselImages,
      duration_ms: durationMs,
      caption: caption ?? null,
    };

    void notifyPhone(payload).then((r) => {
      log.info(
        { batchId, count: carouselImages.length, delivered: r.ws || r.webPush + r.apns > 0, durationMs },
        'show_images pushed',
      );
    });

    // Chat channels post them as attachments (channels/hub.ts).
    if (publish !== false) {
      publishAgentFiles(
        images.map((img) => (img.path ? { ...img, path: resolveAllowedImagePath(img.path) ?? img.path } : img)),
        caption ?? null,
      );
    }

    return {
      ok: true,
      count: carouselImages.length,
      delivered: true,
      batch_id: batchId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'show_images failed');
    return { ok: false, count: 0, delivered: false, error: message };
  }
}
