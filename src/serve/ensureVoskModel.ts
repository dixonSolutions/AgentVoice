/**
 * Server-side wake-word model preparation.
 *
 * The bridge — not each client — owns the Vosk model. If it is missing from
 * the directory the bridge serves `/vosk/` from (`voskPaths().serveFrom[0]`,
 * i.e. `~/.agentvoice/vosk`), this downloads and repacks it once, reporting
 * progress so the socket can relay a live status to connected clients. Every
 * caller shares one in-flight preparation (memoised), so N clients connecting
 * during a cold start trigger a single download, not N.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { childLogger } from '../log.js';
import { voskPaths } from './voskPaths.js';

const log = childLogger('vosk-ensure');

const MODEL_ZIP_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const MODEL_DIR_NAME = 'vosk-model-small-en-us-0.15';
/** Below this, whatever we fetched is an error page, not a model. */
const MIN_PLAUSIBLE_BYTES = 10 * 1024 * 1024;
/** gzip magic — a valid model.tar.gz starts with these two bytes. */
const GZIP_MAGIC = [0x1f, 0x8b];

export type VoskPrepareStatus =
  | { phase: 'ready'; label: string }
  | { phase: 'downloading'; label: string; loadedBytes: number; totalBytes: number | null; fraction: number | null }
  | { phase: 'unpacking'; label: string }
  | { phase: 'error'; label: string; message: string };

type ProgressFn = (status: VoskPrepareStatus) => void;

const LABEL = 'Wake-word model';

let inFlight: Promise<void> | null = null;
let lastStatus: VoskPrepareStatus = { phase: 'ready', label: LABEL };
const listeners = new Set<ProgressFn>();

/** The latest preparation status — sent to a client the moment it connects. */
export function currentVoskStatus(): VoskPrepareStatus {
  return lastStatus;
}

/** Subscribe to preparation progress. Returns an unsubscribe function. */
export function onVoskStatus(fn: ProgressFn): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(status: VoskPrepareStatus): void {
  lastStatus = status;
  for (const fn of listeners) {
    try {
      fn(status);
    } catch {
      /* a bad listener must not break preparation */
    }
  }
}

async function looksLikeModel(path: string): Promise<boolean> {
  try {
    if (statSync(path).size < MIN_PLAUSIBLE_BYTES) return false;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(2);
      await fh.read(buf, 0, 2, 0);
      return buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1];
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status} ${res.statusText})`.trim());
  }
  const totalBytes = Number(res.headers.get('content-length')) || null;
  let loadedBytes = 0;
  let lastEmit = 0;
  const counted = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = res.body!.getReader();
      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          loadedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastEmit > 200) {
            lastEmit = now;
            emit({
              phase: 'downloading',
              label: LABEL,
              loadedBytes,
              totalBytes,
              fraction: totalBytes ? Math.min(1, loadedBytes / totalBytes) : null,
            });
          }
          controller.enqueue(value);
          return pump();
        });
      return pump();
    },
  });
  await pipeline(Readable.fromWeb(counted as never), createWriteStream(dest));
}

async function prepare(target: string, dir: string): Promise<void> {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    throw new Error('`tar` and `unzip` are required to prepare the wake-word model');
  }

  const work = resolve(tmpdir(), `agentvoice-vosk-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'model.zip');
  try {
    log.info({ url: MODEL_ZIP_URL }, 'preparing wake-word model');
    emit({ phase: 'downloading', label: LABEL, loadedBytes: 0, totalBytes: null, fraction: null });
    await download(MODEL_ZIP_URL, zip);

    const size = statSync(zip).size;
    if (size < MIN_PLAUSIBLE_BYTES) {
      throw new Error(`downloaded only ${size} bytes — that is not the model`);
    }

    emit({ phase: 'unpacking', label: LABEL });
    execFileSync('unzip', ['-q', '-o', zip, '-d', work], { stdio: 'ignore' });
    const extracted = join(work, MODEL_DIR_NAME);
    if (!existsSync(extracted)) {
      throw new Error(`expected ${MODEL_DIR_NAME}/ inside the archive`);
    }

    // vosk-browser wants the model's *contents* at the tarball root.
    mkdirSync(dir, { recursive: true });
    const tmpTarget = `${target}.tmp`;
    execFileSync('tar', ['-czf', tmpTarget, '-C', extracted, '.'], { stdio: 'ignore' });
    // Atomic swap so a client never fetches a half-written archive. renameSync,
    // not `mv`: there is no `mv` on Windows.
    renameSync(tmpTarget, target);

    const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
    log.info({ target, mb }, 'wake-word model ready');
    emit({ phase: 'ready', label: LABEL });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The first valid model.tar.gz in any directory `/vosk/` is served from, or
 * null. A clone may already have one in web/public — that counts; fetching a
 * second copy into the home would only waste 41 MB.
 */
export async function findPreparedModel(): Promise<string | null> {
  for (const dir of voskPaths().serveFrom) {
    const candidate = join(dir, 'model.tar.gz');
    if (await looksLikeModel(candidate)) return candidate;
  }
  return null;
}

/**
 * Ensure the wake-word model exists in a directory the bridge serves from,
 * preparing it into the first one (the user's home) when none has it.
 * Memoised: concurrent callers share one preparation. Resolves when ready;
 * rejects (and emits an `error` status) if preparation fails. `force`
 * re-downloads even when a model is already present.
 */
export function ensureVoskModel(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const dir = voskPaths().serveFrom[0];
    if (!dir) throw new Error('no serve directory for the wake-word model');
    const target = join(dir, 'model.tar.gz');

    if (!opts.force && (await findPreparedModel())) {
      emit({ phase: 'ready', label: LABEL });
      return;
    }
    try {
      await prepare(target, dir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'wake-word model preparation failed');
      emit({ phase: 'error', label: LABEL, message });
      throw err;
    }
  })().finally(() => {
    // Allow a later retry (e.g. after a failure) to start fresh.
    inFlight = null;
  });
  return inFlight;
}
