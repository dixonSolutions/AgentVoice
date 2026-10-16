/**
 * send_files — hand the user files: a recording, a video, a screenshot, a
 * document. Delivered wherever they are listening — a chat channel posts them
 * as attachments (channels/hub.ts), and images also go to the phone's
 * carousel (show_images). Non-blocking, like show_images.
 *
 * Both tools publish an `agent_files` event with what they sent, so every
 * surface sees the same files.
 */

import { publishEvent } from '../../state/eventBus.js';
import { childLogger } from '../../log.js';
import { SendFilesSchema } from '../schemas.js';
import { resolveAllowedImagePath } from './imageRegistry.js';
import { handleShowImages } from './imageToolHandlers.js';

const log = childLogger('mcp:server:fileTools');

export interface AgentFileOut {
  path?: string;
  url?: string;
  data?: string;
  mime?: string;
  name?: string;
  caption?: string;
}

/** Tell every surface the agent sent files (paths already checked against the allowlist). */
export function publishAgentFiles(files: AgentFileOut[], caption: string | null): void {
  if (files.length) publishEvent({ type: 'agent_files', files, caption });
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function handleSendFiles(args: unknown): { ok: boolean; count: number; error?: string } {
  const parsed = SendFilesSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, count: 0, error: parsed.error.errors.map((e) => e.message).join('; ') };
  }
  const { files, caption } = parsed.data;
  const out: AgentFileOut[] = [];
  for (const f of files) {
    if (f.path) {
      const resolved = resolveAllowedImagePath(f.path);
      if (!resolved) return { ok: false, count: 0, error: `${f.path} is not a readable file under a project or the temp directory` };
      out.push({ ...f, path: resolved });
    } else {
      out.push(f);
    }
  }
  // Images also land in the phone's carousel.
  const images = out.filter((f) => (f.path && IMAGE.test(f.path)) || f.mime?.startsWith('image/'));
  if (images.length) {
    handleShowImages({ images: images.slice(0, 10).map(({ name: _n, ...img }) => img), ...(caption ? { caption } : {}), publish: false });
  }
  publishAgentFiles(out, caption ?? null);
  log.info({ count: out.length }, 'send_files published');
  return { ok: true, count: out.length };
}
