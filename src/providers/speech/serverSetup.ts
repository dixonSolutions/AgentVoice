/**
 * One-click lifecycle for the self-hosted speech server: pull image → run
 * container → wait for health → install the models each direction needs.
 *
 * Setup blocks for a long time (a multi-GB image pull plus model downloads), so
 * routes run it in the background and stream these progress events, exactly
 * like the hosting-provider setup flow in src/routes/hostingAdmin.ts.
 *
 * One container serves both directions, so this installs the Whisper model when
 * `local_whisper` is in the speech-input chain and the TTS model when
 * `local_speech` is in the output chain — and only those.
 */

import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import {
  containerLogs,
  imageExists,
  inspectContainer,
  listContainerRuntimes,
  pullImage,
  removeContainer,
  resolveRuntime,
  runContainer,
  startExistingContainer,
  stopContainer,
  type ContainerRuntimeInfo,
  type ContainerState,
} from './container.js';
import { readErrorDetail, speechFetch } from './http.js';
import {
  probeSpeechServer,
  speechServerApiBase,
  speechServerRoot,
  speechServerSettings,
} from './server.js';
import { speechInputChain } from './input/orchestrator.js';
import { resolveSpeechInputModel, transcribeWith } from './input/service.js';
import { probePcm16 } from './wav.js';

const log = childLogger('speech:server-setup');

export interface SpeechSetupProgressEvent {
  message: string;
  done?: boolean;
  error?: string;
}

export type SpeechSetupProgressCallback = (event: SpeechSetupProgressEvent) => void;

export interface SpeechSetupResult {
  ok: boolean;
  detail: string;
  serverUrl: string | null;
}

export interface SpeechServerStatus {
  manage: 'container' | 'external';
  serverUrl: string;
  reachable: boolean;
  detail?: string;
  /** Models this server is expected to hold, by direction. */
  inputModel: string | null;
  outputModel: string | null;
  gpu: boolean;
  image: string;
  imagePresent: boolean;
  containerName: string;
  container: ContainerState;
  runtime: ContainerRuntimeInfo | null;
  runtimes: ContainerRuntimeInfo[];
  modelVolume: string;
}

const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_INTERVAL_MS = 3_000;
/** Weights can be multi-GB and are fetched from Hugging Face on demand. */
const MODEL_DOWNLOAD_TIMEOUT_MS = 1_800_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function outputSettings() {
  return getConfig().settings.workflow.llmIntelligence.audio.tts;
}

/** Whisper model to install, or null when no local input provider is in play. */
function wantedInputModel(): string | null {
  return speechInputChain().includes('local_whisper') ? resolveSpeechInputModel('local_whisper') : null;
}

/** TTS model to install, or null when no local output provider is in play. */
function wantedOutputModel(): string | null {
  const tts = outputSettings();
  const inChain = tts.provider === 'local_speech' || tts.fallbacks.includes('local_speech');
  if (!inChain) return null;
  return tts.models['local_speech']?.trim() || 'speaches-ai/Kokoro-82M-v1.0-ONNX';
}

export async function getSpeechServerStatus(): Promise<SpeechServerStatus> {
  const settings = speechServerSettings();
  const runtimes = await listContainerRuntimes();
  const probe = await probeSpeechServer(settings);

  const base = {
    manage: settings.manage,
    serverUrl: speechServerRoot(settings),
    reachable: probe.reachable,
    ...(probe.detail ? { detail: probe.detail } : {}),
    inputModel: wantedInputModel(),
    outputModel: wantedOutputModel(),
    gpu: settings.gpu,
    image: settings.image,
    containerName: settings.containerName,
    modelVolume: settings.modelVolume,
  };

  const noContainer: ContainerState = {
    exists: false,
    running: false,
    image: null,
    status: null,
    startedAt: null,
  };

  if (settings.manage === 'external') {
    return { ...base, runtime: null, runtimes, imagePresent: false, container: noContainer };
  }

  const runtime = await resolveRuntime(settings.runtime);
  if (!runtime.usable) {
    return { ...base, runtime, runtimes, imagePresent: false, container: noContainer };
  }

  const [imagePresent, container] = await Promise.all([
    imageExists(runtime.id, settings.image),
    inspectContainer(runtime.id, settings.containerName),
  ]);

  return { ...base, runtime, runtimes, imagePresent, container };
}

async function waitForHealth(onProgress: SpeechSetupProgressCallback): Promise<boolean> {
  const settings = speechServerSettings();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let announced = false;

  while (Date.now() < deadline) {
    if ((await probeSpeechServer(settings)).reachable) return true;
    if (!announced) {
      onProgress({ message: `Waiting for ${speechServerRoot(settings)} to answer…` });
      announced = true;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

/**
 * Stream the container's last log line every few seconds so a long download
 * shows movement. These servers report Hugging Face progress on stderr; there
 * is no structured percentage to read, so the log tail is the honest signal.
 */
function tailContainerProgress(onProgress: SpeechSetupProgressCallback): () => void {
  const settings = speechServerSettings();
  if (settings.manage !== 'container') return () => undefined;

  let timer: NodeJS.Timeout | null = null;
  let lastLine = '';
  let stopped = false;

  void resolveRuntime(settings.runtime).then((runtime) => {
    if (stopped || !runtime.usable) return;
    timer = setInterval(() => {
      void containerLogs(runtime.id, settings.containerName, 3).then((text) => {
        const line = text.split('\n').filter(Boolean).pop()?.trim() ?? '';
        if (line && line !== lastLine) {
          lastLine = line;
          onProgress({ message: line });
        }
      });
    }, 5_000);
  });

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * Install a model on the server.
 *
 * speaches does NOT download lazily on first use — it answers "Model 'X' is not
 * installed locally. You can download the model using `POST /v1/models`". So ask
 * explicitly, then fall back gracefully for servers with no model-management
 * API (whisper.cpp ships its weights in the image).
 *
 * Model ids contain a slash (`Systran/faster-whisper-small`) and these servers
 * route it as a path segment, so it must NOT be percent-encoded.
 */
async function installModel(model: string, onProgress: SpeechSetupProgressCallback): Promise<boolean> {
  const modelUrl = `${speechServerApiBase()}/models/${model}`;

  try {
    const existing = await speechFetch(modelUrl, { method: 'GET' }, { timeoutMs: 10_000 });
    if (existing.ok) {
      onProgress({ message: `Model ${model} is already installed.` });
      return true;
    }
  } catch {
    // No model API, or the server is mid-start — fall through to the POST.
  }

  onProgress({ message: `Downloading ${model} — first run only, this can take several minutes.` });
  const stopTail = tailContainerProgress(onProgress);

  try {
    const res = await speechFetch(modelUrl, { method: 'POST' }, { timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS });
    if (res.ok) {
      onProgress({ message: `Model ${model} downloaded.` });
      return true;
    }
    if (res.status === 404 || res.status === 405) {
      onProgress({
        message: 'Server has no model-download API — assuming its weights ship with the image.',
      });
      return true;
    }
    const detail = await readErrorDetail(res);
    onProgress({ message: `Model download failed: ${detail}`, error: detail });
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ message: `Model download failed: ${message}`, error: message });
    return false;
  } finally {
    stopTail();
  }
}

/** Prove the input model transcribes — installed is not the same as loadable. */
async function warmUpInput(model: string, onProgress: SpeechSetupProgressCallback): Promise<boolean> {
  onProgress({ message: `Loading ${model} into memory…` });
  try {
    await transcribeWith('local_whisper', probePcm16(), { model });
    onProgress({ message: `${model} is loaded and answering.` });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ message: `Warm-up failed: ${message}`, error: message });
    return false;
  }
}

async function prepareModels(onProgress: SpeechSetupProgressCallback): Promise<boolean> {
  const input = wantedInputModel();
  const output = wantedOutputModel();

  if (!input && !output) {
    onProgress({
      message: 'Server is up. No local model selected yet — pick one for speech in or out, then run setup again.',
    });
    return true;
  }

  let ok = true;
  if (input) {
    ok = (await installModel(input, onProgress)) && (await warmUpInput(input, onProgress));
  }
  // Output weights are small (Kokoro is ~80M params); install even if input failed
  // so a half-configured server still gains one working direction.
  if (output && !(await installModel(output, onProgress))) ok = false;

  return ok;
}

export async function setupSpeechServer(
  onProgress: SpeechSetupProgressCallback,
): Promise<SpeechSetupResult> {
  const settings = speechServerSettings();
  const serverUrl = speechServerRoot(settings);

  if (settings.manage === 'external') {
    onProgress({ message: `Checking external speech server at ${serverUrl}…` });
    if (!(await probeSpeechServer(settings)).reachable) {
      const detail = `No OpenAI-compatible server at ${speechServerApiBase(settings)}`;
      onProgress({ message: detail, done: true, error: detail });
      return { ok: false, detail, serverUrl };
    }
    const ok = await prepareModels(onProgress);
    const detail = ok
      ? `External speech server ready at ${serverUrl}`
      : 'Server reachable but a model did not load — check its model list';
    onProgress({ message: detail, done: true, ...(ok ? {} : { error: detail }) });
    return { ok, detail, serverUrl };
  }

  const runtime = await resolveRuntime(settings.runtime);
  if (!runtime.usable) {
    const detail = runtime.detail ?? `${runtime.id} is unavailable`;
    onProgress({ message: detail, done: true, error: detail });
    return { ok: false, detail, serverUrl };
  }
  onProgress({ message: `Using ${runtime.id}${runtime.version ? ` ${runtime.version}` : ''}.` });

  if (await imageExists(runtime.id, settings.image)) {
    onProgress({ message: `Image ${settings.image} is already present.` });
  } else {
    onProgress({ message: `Pulling ${settings.image} — this is a large download.` });
    if (!(await pullImage(runtime.id, settings.image, (line) => onProgress({ message: line })))) {
      const detail = `Failed to pull ${settings.image}`;
      onProgress({ message: detail, done: true, error: detail });
      return { ok: false, detail, serverUrl };
    }
  }

  const existing = await inspectContainer(runtime.id, settings.containerName);
  if (existing.exists && existing.image !== settings.image) {
    // Image changed under a container of the same name — recreate rather than
    // silently keep running the old one.
    onProgress({
      message: `Replacing container ${settings.containerName} (was ${existing.image ?? 'unknown image'}).`,
    });
    await removeContainer(runtime.id, settings.containerName);
  } else if (existing.exists && !existing.running) {
    onProgress({ message: `Starting existing container ${settings.containerName}…` });
    if (!(await startExistingContainer(runtime.id, settings.containerName))) {
      onProgress({ message: 'Existing container would not start — recreating.' });
      await removeContainer(runtime.id, settings.containerName);
    }
  }

  const state = await inspectContainer(runtime.id, settings.containerName);
  if (!state.running) {
    if (state.exists) await removeContainer(runtime.id, settings.containerName);
    onProgress({ message: `Starting ${settings.containerName} on 127.0.0.1:${settings.port}…` });
    const started = await runContainer(
      {
        runtime: runtime.id,
        name: settings.containerName,
        image: settings.image,
        hostPort: settings.port,
        containerPort: settings.containerPort,
        modelVolume: settings.modelVolume,
        modelCachePath: settings.modelCachePath,
        gpu: settings.gpu,
      },
      (line) => onProgress({ message: line }),
    );
    if (!started) {
      const detail = `Container ${settings.containerName} failed to start — check ${runtime.id} logs`;
      onProgress({ message: detail, done: true, error: detail });
      return { ok: false, detail, serverUrl };
    }
  }

  if (!(await waitForHealth(onProgress))) {
    const tail = await containerLogs(runtime.id, settings.containerName, 20);
    const detail = `Speech server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`;
    if (tail) onProgress({ message: tail });
    onProgress({ message: detail, done: true, error: detail });
    return { ok: false, detail, serverUrl };
  }
  onProgress({ message: `Server is up at ${serverUrl}.` });

  const ok = await prepareModels(onProgress);
  const detail = ok
    ? `Self-hosted speech server ready at ${serverUrl}`
    : 'Container is running but a model failed to load';
  onProgress({ message: detail, done: true, ...(ok ? {} : { error: detail }) });
  log.info({ ok, serverUrl }, 'speech server setup finished');

  return { ok, detail, serverUrl };
}

export async function stopSpeechServer(remove = false): Promise<{ ok: boolean; detail: string }> {
  const settings = speechServerSettings();
  if (settings.manage === 'external') {
    return { ok: false, detail: 'External servers are not managed by the bridge' };
  }

  const runtime = await resolveRuntime(settings.runtime);
  if (!runtime.usable) {
    return { ok: false, detail: runtime.detail ?? `${runtime.id} is unavailable` };
  }

  if (remove) {
    await removeContainer(runtime.id, settings.containerName);
    return { ok: true, detail: `Removed ${settings.containerName} (model volume kept)` };
  }

  await stopContainer(runtime.id, settings.containerName);
  return { ok: true, detail: `Stopped ${settings.containerName}` };
}

export async function getSpeechServerLogs(lines = 80): Promise<string> {
  const settings = speechServerSettings();
  if (settings.manage === 'external') return '';
  const runtime = await resolveRuntime(settings.runtime);
  if (!runtime.usable) return runtime.detail ?? '';
  return containerLogs(runtime.id, settings.containerName, lines);
}
