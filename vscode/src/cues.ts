/**
 * Voice cues, played host-side.
 *
 * Same four sounds the phone uses (@agentvoice/client owns the list and the
 * debounce), same files, copied into media/sounds at build time. They play
 * through the extension host rather than the webview for the same reason
 * speech does: VS Code's autoplay policy makes webview audio unreliable.
 *
 * A cue must never make the user wait. Every call is fire-and-forget, and a
 * missing player or file degrades to silence, not to an error.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { CUE_FILENAME, shouldPlayCue, type VoiceCue } from '@agentvoice/client';

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
const PLAYERS: { command: string; args: (file: string) => string[] }[] = [
  { command: 'ffplay', args: (f) => ['-nodisp', '-autoexit', '-loglevel', 'error', f] },
  { command: 'mpv', args: (f) => ['--no-video', '--really-quiet', f] },
  { command: 'paplay', args: (f) => [f] },
  { command: 'pw-play', args: (f) => [f] },
];

export class VoiceCues {
  private readonly lastPlayedAt = new Map<VoiceCue, number>();
  /** Index of the player known to work, so we stop retrying missing ones. */
  private playerIndex = 0;
  private enabled = true;

  constructor(private readonly mediaRoot: vscode.Uri) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  play(cue: VoiceCue, opts: { force?: boolean } = {}): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (!shouldPlayCue(this.lastPlayedAt.get(cue), now, opts)) return;
    this.lastPlayedAt.set(cue, now);

    const file = vscode.Uri.joinPath(this.mediaRoot, 'sounds', CUE_FILENAME[cue]).fsPath;
    if (!existsSync(file)) return;
    this.spawnFrom(this.playerIndex, file);
  }

  private spawnFrom(index: number, file: string): void {
    const player = PLAYERS[index];
    if (!player) return;
    const startedAt = Date.now();
    const child = spawn(player.command, player.args(file), { stdio: 'ignore' });
    child.on('error', () => {
      // ENOENT arrives async — try the next player and remember the choice.
      this.playerIndex = index + 1;
      this.spawnFrom(index + 1, file);
    });
    child.on('close', (code) => {
      // Exiting non-zero straight away means it could not decode the file, not
      // that the cue played. Move on and remember the one that works.
      if (code !== 0 && Date.now() - startedAt < 1500) {
        this.playerIndex = index + 1;
        this.spawnFrom(index + 1, file);
        return;
      }
      this.playerIndex = index;
    });
  }
}
