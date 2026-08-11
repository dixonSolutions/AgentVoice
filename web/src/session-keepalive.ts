/**
 * Foreground session keepalive for mobile PWAs.
 *
 * While a voice session is active:
 * - Screen Wake Lock — delays auto-lock (screen stays on)
 * - Silent looping HTML audio — signals an active media session to iOS/Android
 * - Media Session API — lock-screen / Control Center metadata
 *
 * Does not grant background mic or VoIP privileges. See docs/19-mobile-session-keepalive.md.
 */

import { unlockAudioContext } from './audio.js';

/** ~0.1 s mono silent WAV — loops inaudibly via HTMLAudioElement. */
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';

export interface SessionKeepAliveOptions {
  title?: string;
  artist?: string;
}

export class SessionKeepAlive {
  private wakeLock: WakeLockSentinel | null = null;
  private audio: HTMLAudioElement | null = null;
  private active = false;
  private visibilityBound = false;
  private onVisibleCallback: (() => void) | null = null;

  /** Called when the page becomes visible again (reconnect wake lock, resume silent audio). */
  onVisible(callback: () => void): void {
    this.onVisibleCallback = callback;
  }

  get isActive(): boolean {
    return this.active;
  }

  get wakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async start(options: SessionKeepAliveOptions = {}): Promise<void> {
    if (this.active) {
      await this.refresh();
      return;
    }
    this.active = true;
    this.bindVisibility();
    this.setupMediaSession(options);
    await Promise.all([this.requestWakeLock(), this.startSilentAudio()]);
  }

  stop(): void {
    this.active = false;
    this.releaseWakeLock();
    this.stopSilentAudio();
    this.clearMediaSession();
    this.unbindVisibility();
  }

  /** Re-acquire wake lock and restart silent audio after visibility resume. */
  async refresh(): Promise<void> {
    if (!this.active) return;
    await Promise.all([this.requestWakeLock(), this.startSilentAudio()]);
  }

  private bindVisibility(): void {
    if (this.visibilityBound || typeof document === 'undefined') return;
    this.visibilityBound = true;
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private unbindVisibility(): void {
    if (!this.visibilityBound || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilityBound = false;
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) return;
    void this.refresh();
    this.onVisibleCallback?.();
  };

  private async requestWakeLock(): Promise<void> {
    if (!this.wakeLockSupported || !this.active) return;
    try {
      if (this.wakeLock && !this.wakeLock.released) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch {
      // Permission denied or unsupported — non-fatal.
    }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release();
    this.wakeLock = null;
  }

  private async startSilentAudio(): Promise<void> {
    if (!this.active || typeof document === 'undefined') return;

    await unlockAudioContext();

    if (!this.audio) {
      const el = document.createElement('audio');
      el.src = SILENT_WAV_DATA_URI;
      el.loop = true;
      el.volume = 0.01;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.preload = 'auto';
      document.body.appendChild(el);
      this.audio = el;
    }

    if (this.audio.paused) {
      try {
        await this.audio.play();
      } catch {
        // iOS may block until a fresh user gesture — wake lock still helps.
      }
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  }

  private stopSilentAudio(): void {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.remove();
    this.audio = null;
  }

  private setupMediaSession(options: SessionKeepAliveOptions): void {
    if (!('mediaSession' in navigator)) return;

    const title = options.title ?? 'AgentVoice';
    const artist = options.artist ?? 'Voice session active';

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: 'AgentVoice',
      artwork: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });

    navigator.mediaSession.setActionHandler('play', () => {
      void this.startSilentAudio();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      // Ignore pause — session must stay alive until user hangs up.
    });
  }

  private clearMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.setActionHandler('play', null);
    navigator.mediaSession.setActionHandler('pause', null);
  }
}
