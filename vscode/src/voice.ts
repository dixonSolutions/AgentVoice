/**
 * Voice session — the microphone, in the extension host.
 *
 * A webview cannot hold a mic: VS Code has no permission path for
 * getUserMedia, so `navigator.mediaDevices` is a dead end inside the panel.
 * The extension host is plain Node, though, and the bridge already accepts raw
 * PCM16LE at /api/intelligence/transcribe — so capture happens here, with a
 * system recorder, and the audio goes straight to the bridge's configured STT.
 *
 * Segmentation is silence-based and deliberately dumb: rise above the floor to
 * open an utterance, stay under it for `turnSubmit.silenceMs` to close it. The
 * threshold comes from the bridge's own config so the editor and the phone
 * agree about what counts as the end of a turn.
 *
 * Capture pauses while a turn is in flight, so the agent's own speech coming
 * back out of the speakers cannot open a new utterance.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { isEndPhrase, isStartPhrase, normalizeForWakeMatch, stripStartPhrase } from '@agentvoice/client';
import { errorMessage, type BridgeConnection } from './bridge.js';
import type { VoiceCues } from './cues.js';

/** stdin is 'ignore', so the recorder handle has readable pipes only. */
type MicProcess = ChildProcessByStdio<null, Readable, Readable>;

/** The STT path is fixed at 16 kHz mono s16le (src/providers/speech/wav.ts). */
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
/**
 * Speech threshold, as a multiple of the room's own noise.
 *
 * A fixed RMS number cannot work: it depends on mic gain, distance and the
 * room. Too low and the panel cycles through its states on room tone; too high
 * and ordinary speech never registers. So measure the room at session start and
 * put the bar above it.
 */
const FLOOR_OVER_AMBIENT = 3.5;
/** Never trust a silent room completely — a mic reading ~0 would trigger on anything. */
const MIN_FLOOR = 260;
/** Fallback when calibration cannot run. */
const DEFAULT_FLOOR = 500;
/**
 * An utterance whose own average is not clearly above the floor is room noise
 * that drifted over it, not speech. Discarding it here — rather than posting it
 * — is what stops a quiet room producing a stream of "(too quiet to
 * transcribe)" lines and a stream of billable STT calls.
 */
const UTTERANCE_OVER_FLOOR = 1.6;
/** How long to listen to the room before deciding what silence sounds like. */
const CALIBRATE_MS = 700;
/**
 * Ignore blips. This is deliberately generous: at 400ms a single word like
 * "start" survived as its own turn, and a sentence with ordinary pauses in it
 * arrived as three separate turns.
 */
const MIN_UTTERANCE_MS = 700;
/**
 * How long the room must stay quiet before a turn is closed.
 *
 * The bridge's turnSubmit.silenceMs (700ms) is tuned for the phone's v5 VAD,
 * which distinguishes speech from noise. This is a plain RMS gate, so it must
 * wait out the pauses *inside* a sentence rather than cutting on the first one.
 */
const DEFAULT_SILENCE_MS = 1200;
/** Hard cap so a stuck-open mic cannot post a five-minute clip. */
const MAX_UTTERANCE_MS = 30_000;
/** Analysis frame. Small enough to end a turn promptly, big enough to be stable. */
const FRAME_MS = 100;
/**
 * Consecutive loud frames before we call it speech.
 *
 * One frame over the floor is a keystroke, a chair, a breath — reacting to it
 * made the orb cycle listening → hearing → transcribing continuously while the
 * room was quiet. 300ms of sustained sound is a voice.
 */
const ONSET_FRAMES = 3;

export type VoiceState = 'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'armed' | 'error';

interface WakeWords {
  start: string;
  end: string;
  cancel: string;
}

interface Recorder {
  command: string;
  args: string[];
}

/**
 * Recorders in preference order. PulseAudio/PipeWire first (it follows the
 * desktop's default source), ALSA next, ffmpeg last.
 */
const RECORDERS: Recorder[] = [
  { command: 'parecord', args: ['--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1', '--raw'] },
  { command: 'pw-record', args: ['--format=s16', `--rate=${SAMPLE_RATE}`, '--channels=1', '-'] },
  { command: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-t', 'raw'] },
  { command: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1'] },
];

function rms(frame: Buffer): number {
  const samples = Math.floor(frame.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = frame.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export class VoiceSession implements vscode.Disposable {
  private child: MicProcess | null = null;
  private state: VoiceState = 'off';
  private readonly stateEmitter = new vscode.EventEmitter<{
    state: VoiceState;
    detail?: string;
    wakeWords: boolean;
    startWord: string | null;
  }>();
  readonly onState = this.stateEmitter.event;
  private readonly heardEmitter = new vscode.EventEmitter<{ text: string; ignored: boolean }>();
  /** Every transcript, so the panel can show what the mic actually produced. */
  readonly onHeard = this.heardEmitter.event;
  private readonly levelEmitter = new vscode.EventEmitter<number>();
  /** 0–1 loudness, ~10/s, for the orb. */
  readonly onLevel = this.levelEmitter.event;
  /** Set by the panel: true while the host is playing the agent's own voice. */
  isOutputPlaying: () => boolean = () => false;

  /** Bytes of the utterance currently being spoken. */
  private utterance: Buffer[] = [];
  private utteranceBytes = 0;
  private silentMs = 0;
  private speaking = false;
  /** Loud frames seen back to back, for the onset gate. */
  private onset = 0;
  /** Frames collected while measuring the room; null once calibrated. */
  private calibration: number[] | null = null;
  /** Sum of frame levels in the current utterance, for its mean loudness. */
  private utteranceLevel = 0;
  private utteranceFrames = 0;
  /** Leftover bytes that did not fill a whole analysis frame. */
  private carry: Buffer = Buffer.alloc(0);
  /** True while a transcript is being fetched or a turn is running. */
  private busy = false;
  private silenceMs = DEFAULT_SILENCE_MS;
  private floor = DEFAULT_FLOOR;
  /** From the bridge's own voice.wakeWords — never invented here. */
  private wake: WakeWords | null = null;
  /** Utterances collected since the start word, awaiting the submit word. */
  private pending: string[] = [];
  /** True between the start word and the submit word. */
  private armed = false;

  constructor(
    private readonly bridge: BridgeConnection,
    private readonly cues: VoiceCues,
  ) {}

  get current(): VoiceState {
    return this.state;
  }

  get active(): boolean {
    return this.child !== null;
  }

  private setState(state: VoiceState, detail?: string): void {
    this.state = state;
    this.stateEmitter.fire({ state, detail, wakeWords: this.wake !== null, startWord: this.wake?.start ?? null });
  }

  async toggle(): Promise<void> {
    if (this.active) this.stop();
    else await this.start();
  }

  /**
   * Re-read the bridge's voice settings. Called at session start and whenever
   * the config changes, so toggling wake words in Settings takes effect on the
   * running session instead of at the next restart.
   */
  async loadConfig(): Promise<void> {
    try {
      const config = await this.bridge.http.get<{
        settings?: {
          voice?: {
            turnSubmit?: { silenceMs?: number };
            wakeWords?: Partial<WakeWords>;
            wakeWordsEnabled?: boolean;
          };
        };
      }>('/api/config');
      const voice = config.settings?.voice;
      const bridgeMs = voice?.turnSubmit?.silenceMs;
      // Never go below the floor: the bridge value assumes a real VAD.
      if (typeof bridgeMs === 'number') this.silenceMs = Math.max(bridgeMs, DEFAULT_SILENCE_MS);
      // Wake words are the bridge's, shared with the phone. When they are on,
      // "start" opens a turn and "send" submits it — saying either must never
      // reach the agent as a turn of its own.
      const words = voice?.wakeWords;
      const wake =
        voice?.wakeWordsEnabled !== false && words?.start && words.end && words.cancel
          ? { start: words.start, end: words.end, cancel: words.cancel }
          : null;
      const changed = JSON.stringify(wake) !== JSON.stringify(this.wake);
      this.wake = wake;
      if (changed) {
        this.armed = false;
        this.pending = [];
        this.bridge.log(wake ? `wake words on — say "${wake.start}"` : 'wake words off — every utterance is a turn');
        if (this.active) this.setState('listening');
      }
    } catch {
      // Keep whatever we had; a config blip is not a reason to drop the mic.
    }
  }

  /** What the panel should call the current mode. */
  get wakeWordsOn(): boolean {
    return this.wake !== null;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.bridge.status !== 'connected') {
      void vscode.window.showWarningMessage('AgentVoice: connect to the bridge before starting a voice session.');
      return;
    }
    this.setState('starting');
    await this.loadConfig();

    const cfg = vscode.workspace.getConfiguration('agentvoice');
    const configured = cfg.get<number>('micNoiseFloor') ?? 0;
    // 0 (the default) means "work it out from the room".
    this.floor = configured > 0 ? configured : DEFAULT_FLOOR;
    this.calibration = configured > 0 ? null : [];
    const override = cfg.get<number>('micSilenceMs');
    if (typeof override === 'number' && override >= 300) this.silenceMs = override;

    const child = this.spawnRecorder();
    if (!child) {
      this.cues.play('error', { force: true });
      this.setState('error', 'No recorder found — install pulseaudio-utils (parecord), alsa-utils (arecord) or ffmpeg.');
      return;
    }
    this.child = child;
    this.reset();
    this.setState('listening');

    child.stdout.on('data', (chunk: Buffer) => this.onAudio(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.bridge.log(`mic: ${text}`);
    });
    child.on('error', (err) => {
      this.bridge.log(`mic failed: ${errorMessage(err)}`);
      this.setState('error', errorMessage(err));
      this.stop();
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        // A non-zero exit while we thought we were listening is a real failure.
        if (this.state !== 'off') this.setState(code === 0 ? 'off' : 'error', code === 0 ? undefined : `recorder exited (${code})`);
      }
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.reset();
    this.setState('off');
    child?.kill('SIGTERM');
  }

  private reset(): void {
    this.utterance = [];
    this.utteranceBytes = 0;
    this.silentMs = 0;
    this.speaking = false;
    this.onset = 0;
    this.calibration = null;
    this.utteranceLevel = 0;
    this.utteranceFrames = 0;
    this.carry = Buffer.alloc(0);
    this.armed = false;
    this.pending = [];
  }

  private spawnRecorder(): MicProcess | null {
    const configured = vscode.workspace.getConfiguration('agentvoice').get<string>('micCommand')?.trim();
    const candidates: Recorder[] = configured
      ? [{ command: configured.split(/\s+/)[0] ?? '', args: configured.split(/\s+/).slice(1) }]
      : RECORDERS;
    for (const rec of candidates) {
      if (!rec.command) continue;
      try {
        const child = spawn(rec.command, rec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        // spawn() only reports ENOENT asynchronously, so a bad command still
        // returns a handle here; the 'error' listener above catches it.
        this.bridge.log(`mic: recording with ${rec.command}`);
        return child;
      } catch {
        continue;
      }
    }
    return null;
  }

  private onAudio(chunk: Buffer): void {
    if (!this.child) return;
    const frameBytes = (SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000;
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let offset = 0;
    while (buf.length - offset >= frameBytes) {
      this.onFrame(buf.subarray(offset, offset + frameBytes));
      offset += frameBytes;
    }
    this.carry = buf.subarray(offset);
    buf = Buffer.alloc(0);
  }

  private onFrame(frame: Buffer): void {
    const level = rms(frame);

    if (this.calibration) {
      this.calibration.push(level);
      if (this.calibration.length * FRAME_MS < CALIBRATE_MS) return;
      // Median, not mean: one cough during calibration should not deafen us.
      const sorted = [...this.calibration].sort((a, b) => a - b);
      const ambient = sorted[Math.floor(sorted.length / 2)] ?? 0;
      this.calibration = null;
      this.floor = Math.max(MIN_FLOOR, Math.round(ambient * FLOOR_OVER_AMBIENT));
      this.bridge.log(`mic: room noise ${Math.round(ambient)} → speech threshold ${this.floor}`);
      return;
    }

    // Full scale is 32767, but speech rarely exceeds a third of it — normalise
    // against that so the orb actually moves.
    this.levelEmitter.fire(Math.min(1, level / 9000));
    // While a turn runs, or while the agent is speaking, the loudest thing in
    // the room is us. Listening then just feeds our own voice back in.
    if (this.busy || this.isOutputPlaying()) return;
    const loud = level >= this.floor;

    if (loud) {
      this.onset += 1;
      if (!this.speaking) {
        // Wait for sustained sound before declaring speech, or the panel
        // flickers through its states on room noise.
        if (this.onset < ONSET_FRAMES) return;
        this.speaking = true;
        this.setState('hearing');
      }
      this.silentMs = 0;
      this.utterance.push(Buffer.from(frame));
      this.utteranceBytes += frame.length;
      this.utteranceLevel += level;
      this.utteranceFrames += 1;
    } else if (this.speaking) {
      this.onset = 0;
      // Keep the trailing silence: cutting on the first quiet frame clips
      // consonants off the end of the last word.
      this.utterance.push(Buffer.from(frame));
      this.utteranceBytes += frame.length;
      this.silentMs += FRAME_MS;
      if (this.silentMs >= this.silenceMs) void this.finishUtterance();
    } else {
      this.onset = 0;
    }

    const ms = (this.utteranceBytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
    if (this.speaking && ms >= MAX_UTTERANCE_MS) void this.finishUtterance();
  }

  private async finishUtterance(): Promise<void> {
    const pcm = Buffer.concat(this.utterance);
    const ms = (pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
    this.utterance = [];
    this.utteranceBytes = 0;
    this.silentMs = 0;
    this.speaking = false;

    const mean = this.utteranceFrames > 0 ? this.utteranceLevel / this.utteranceFrames : 0;
    this.utteranceLevel = 0;
    this.utteranceFrames = 0;

    if (ms < MIN_UTTERANCE_MS) {
      this.setState('listening');
      return;
    }
    if (mean < this.floor * UTTERANCE_OVER_FLOOR) {
      // Not speech — do not spend a transcription call on it.
      this.bridge.log(`mic: ignored ${Math.round(ms)}ms at level ${Math.round(mean)} (floor ${this.floor})`);
      this.setState('listening');
      return;
    }

    this.busy = true;
    this.setState('transcribing');
    try {
      const result = await this.bridge.http.request<{ text: string; provider?: string }>('/api/intelligence/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm as unknown as BodyInit,
      });
      const text = result.text?.trim();
      if (text) {
        this.bridge.log(`heard (${result.provider ?? 'stt'}): ${text}`);
        await this.route(text);
      }
    } catch (err) {
      // 422 is the bridge saying "no speech in that clip" — expected on a cough.
      const message = errorMessage(err);
      this.bridge.log(`transcribe failed: ${message}`);
      if (/no speech detected/i.test(message)) {
        // Expected on a cough — but also what a too-quiet speaker gets, and
        // silently dropping it looks identical to the mic being dead.
        this.heardEmitter.fire({ text: '(too quiet to transcribe)', ignored: true });
      } else {
        this.cues.play('error', { force: true });
        this.setState('error', message);
      }
    } finally {
      this.busy = false;
      if (this.active && this.state !== 'error') {
        this.setState(this.pending.length > 0 || this.armed ? 'armed' : 'listening');
      }
    }
  }

  /**
   * Decide what a transcript means. Without wake words every utterance is a
   * turn (the old behaviour). With them, speech is buffered between the start
   * and submit words, so ordinary pauses no longer chop one request into three.
   */
  private async route(text: string): Promise<void> {
    const wake = this.wake;
    if (!wake) {
      this.heardEmitter.fire({ text, ignored: false });
      this.cues.play('sent');
      await vscode.commands.executeCommand('agentvoice.__submit', text);
      return;
    }

    // Same rules the phone's spotters use (@agentvoice/client): the start word
    // may lead an utterance ("start open the file") and the submit word may
    // trail one ("open the file send"), so a whole request can arrive at once.
    this.heardEmitter.fire({ text, ignored: false });
    if (normalizeForWakeMatch(text) === normalizeForWakeMatch(wake.cancel)) {
      this.armed = false;
      this.pending = [];
      this.cues.play('cancel');
      this.bridge.log('wake: cancelled');
      return;
    }

    let body = text;
    if (isStartPhrase(text, wake.start)) {
      this.armed = true;
      this.pending = [];
      body = stripStartPhrase(text, wake.start);
      this.cues.play('listening');
      this.bridge.log('wake: armed');
    } else if (!this.armed) {
      this.bridge.log(`ignored (say "${wake.start}" first): ${text}`);
      this.heardEmitter.fire({ text, ignored: true });
      return;
    }

    if (isEndPhrase(body, wake.end)) {
      const norm = normalizeForWakeMatch(wake.end);
      // Trim the trailing submit word off the content it arrived with.
      const trimmed = normalizeForWakeMatch(body) === norm
        ? ''
        : body.replace(new RegExp(`[\\s\\p{P}]*${norm}[\\s\\p{P}]*$`, 'iu'), '').trim();
      if (trimmed) this.pending.push(trimmed);
      const turn = this.pending.join(' ').trim();
      this.armed = false;
      this.pending = [];
      if (!turn) {
        this.bridge.log('wake: submit with nothing buffered');
        return;
      }
      this.cues.play('sent');
      await vscode.commands.executeCommand('agentvoice.__submit', turn);
      return;
    }

    if (body.trim()) this.pending.push(body.trim());
  }

  dispose(): void {
    this.stop();
    this.stateEmitter.dispose();
    this.levelEmitter.dispose();
    this.heardEmitter.dispose();
  }
}
