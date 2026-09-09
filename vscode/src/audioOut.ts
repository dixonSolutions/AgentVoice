/**
 * Speech output — played by the extension host, not the webview.
 *
 * The panel used to play bridge TTS itself, and VS Code's autoplay policy kept
 * refusing it ("sound is blocked by the editor"): a webview never reliably
 * holds the user activation a media element needs. The host has no such rule,
 * so playback moved here alongside the microphone. Nothing to enable, nothing
 * to click — if read-aloud is on, the agent is audible.
 *
 * The panel still owns the read-along shading, so this reports when a clip
 * starts (with its measured duration) and when it ends, and the webview paces
 * the highlight across that window.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { errorMessage, type BridgeConnection } from './bridge.js';

interface Player {
  command: string;
  /** Built from the file path — players disagree about flag order. */
  args: (file: string) => string[];
}

/**
 * Players in preference order.
 *
 * ffplay and mpv lead because they decode MP3, which is what bridge TTS and the
 * cue assets are. Inside the flatpak sandbox `paplay` is built against a
 * libsndfile with no MP3 support: it prints "Failed to open audio file" and
 * exits 1 — a *successful spawn* that plays nothing. That silently swallowed
 * every sound while the speakers were working fine, so a non-zero exit now
 * falls through to the next player rather than counting as played.
 */
const PLAYERS: Player[] = [
  { command: 'ffplay', args: (f) => ['-nodisp', '-autoexit', '-loglevel', 'error', f] },
  { command: 'mpv', args: (f) => ['--no-video', '--really-quiet', f] },
  { command: 'paplay', args: (f) => [f] },
  { command: 'pw-play', args: (f) => [f] },
];

export interface SpeechEvent {
  id: string;
  phase: 'start' | 'end' | 'error';
  /** Milliseconds, when known — lets the panel pace the read-along. */
  durationMs?: number;
  provider?: string | null;
  message?: string;
}

export class SpeechOutput implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private dir: string | null = null;
  private seq = 0;
  private readonly emitter = new vscode.EventEmitter<SpeechEvent>();
  readonly onEvent = this.emitter.event;
  /** Raised while a clip plays, so the mic does not hear the agent. */
  private playing = false;

  constructor(private readonly bridge: BridgeConnection) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Fetch TTS for one line and play it. Resolves when playback finishes. */
  async speak(id: string, text: string): Promise<void> {
    this.stop();
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const clip = await this.bridge.http.tts(trimmed);
      const file = await this.write(Buffer.from(clip.audio), clip.contentType);
      const durationMs = await this.duration(file);
      this.emitter.fire({ id, phase: 'start', durationMs, provider: clip.provider });
      await this.play(file);
      this.emitter.fire({ id, phase: 'end' });
    } catch (err) {
      const message = errorMessage(err);
      this.bridge.log(`speech failed: ${message}`);
      this.emitter.fire({ id, phase: 'error', message });
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.playing = false;
    child?.kill('SIGTERM');
  }

  private async write(audio: Buffer, contentType: string): Promise<string> {
    if (!this.dir) this.dir = await mkdtemp(join(tmpdir(), 'agentvoice-tts-'));
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
    const file = join(this.dir, `clip-${++this.seq}.${ext}`);
    await writeFile(file, audio);
    return file;
  }

  /** ffprobe if it exists; the panel falls back to word-count pacing if not. */
  private async duration(file: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      let out = '';
      const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      probe.stdout.on('data', (c: Buffer) => (out += c.toString()));
      probe.on('error', () => resolve(undefined));
      probe.on('close', () => {
        const seconds = Number.parseFloat(out.trim());
        resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined);
      });
    });
  }

  private play(file: string): Promise<void> {
    return new Promise((resolve) => {
      const attempt = (index: number): void => {
        const player = PLAYERS[index];
        if (!player) {
          this.bridge.log('speech: no player found — install pulseaudio-utils, ffmpeg or mpv');
          this.playing = false;
          resolve();
          return;
        }
        const startedAt = Date.now();
        const child = spawn(player.command, player.args(file), { stdio: 'ignore' });
        this.child = child;
        this.playing = true;
        // ENOENT arrives asynchronously, so a missing player looks like a
        // successful spawn until this fires — fall through to the next one.
        child.on('error', () => {
          if (this.child === child) this.child = null;
          attempt(index + 1);
        });
        child.on('close', (code) => {
          if (this.child !== child) return;
          this.child = null;
          // A player that refuses the format exits non-zero, immediately. Treat
          // that as "cannot play this" and try the next, rather than reporting
          // a clip as spoken when nothing was heard.
          if (code !== 0 && Date.now() - startedAt < 1500) {
            this.bridge.log(`speech: ${player.command} could not play the clip (exit ${code}) — trying the next player`);
            attempt(index + 1);
            return;
          }
          this.playing = false;
          resolve();
        });
      };
      attempt(0);
    });
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
    if (this.dir) void rm(this.dir, { recursive: true, force: true });
  }
}
