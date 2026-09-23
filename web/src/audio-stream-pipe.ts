/**
 * Direct audio stream — the PWA side of /ws/audio-stream.
 *
 * In `stream` input mode the phone stops taking turns: no wake phrase, no VAD,
 * no per-turn upload. The mic is piped to the bridge as PCM16LE at 16 kHz for
 * as long as the session is live and unmuted; the bridge cuts it at pauses,
 * transcribes each piece and hands it to the agent as it lands (see
 * src/routes/audioStream.ts). Turns stay the recommended mode — they give the
 * agent whole requests — but this one is hands-free and lower-latency.
 *
 * Sending pauses while the agent's voice plays, so the assistant is never
 * transcribed back to itself; the segment in progress is cut at that moment
 * so speech before and after the reply is never glued together.
 */

import {
  connectSilentSink,
  createMicProcessingChain,
  getSharedAudioContext,
  type MicProcessingChain,
} from './audio.js';
import { downsampleTo16k, PCM_SAMPLE_RATE } from './pcm16.js';

export interface StreamSegmentInfo {
  index: number;
  audioMs: number;
  latencyMs: number;
  delivered: boolean;
  /** Why an undelivered segment was dropped (e.g. no project selected). */
  message?: string;
}

export interface AudioStreamPipeCallbacks {
  onReady?(info: { stt: string }): void;
  onSegment(text: string, info: StreamSegmentInfo): void;
  onError(message: string, fatal: boolean): void;
  onClosed?(reason: string): void;
}

/** Stop queueing audio when the socket is this far behind (a stalled network). */
const MAX_BUFFERED_BYTES = 512 * 1024;

export class AudioStreamPipeClient {
  private ws: WebSocket | null = null;
  private chain: MicProcessingChain | null = null;
  private processor: ScriptProcessorNode | null = null;
  private paused = false;
  private ready = false;
  private closed = false;
  private droppedFrames = 0;

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: AudioStreamPipeCallbacks,
  ) {}

  /** Open the socket, wait for `ready`, then start piping `mic`. Rejects on a fatal refusal. */
  async start(mic: MediaStream): Promise<void> {
    const url = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/audio-stream`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: this.appToken }));
      });

      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (msg['type']) {
          case 'auth_ok':
            ws.send(
              JSON.stringify({
                type: 'start',
                sampleRate: PCM_SAMPLE_RATE,
                encoding: 'pcm_s16le',
                channels: 1,
                client: 'pwa',
                // The /ws/intelligence socket already receives the agent's replies.
                listen: false,
              }),
            );
            break;
          case 'ready':
            this.ready = true;
            this.cb.onReady?.({ stt: typeof msg['stt'] === 'string' ? msg['stt'] : 'server STT' });
            finish(resolve);
            break;
          case 'segment': {
            const text = typeof msg['text'] === 'string' ? msg['text'] : '';
            if (!text) break;
            this.cb.onSegment(text, {
              index: Number(msg['index'] ?? 0),
              audioMs: Number(msg['audio_ms'] ?? 0),
              latencyMs: Number(msg['latency_ms'] ?? 0),
              delivered: msg['delivered'] !== false,
              ...(typeof msg['message'] === 'string' ? { message: msg['message'] } : {}),
            });
            break;
          }
          case 'error': {
            const message = typeof msg['message'] === 'string' ? msg['message'] : 'Audio stream error';
            const fatal = msg['fatal'] === true;
            if (fatal && !settled) {
              finish(() => reject(new Error(message)));
            } else {
              this.cb.onError(message, fatal);
            }
            break;
          }
          default:
            break;
        }
      });

      ws.addEventListener('error', () => {
        finish(() => reject(new Error('Audio stream WebSocket error')));
      });

      ws.addEventListener('close', (ev) => {
        const reason = ev.reason?.trim() || `closed (${ev.code})`;
        if (!settled) {
          finish(() => reject(new Error(reason)));
          return;
        }
        if (!this.closed) this.cb.onClosed?.(reason);
      });
    });

    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    // No noise gate: the bridge's energy segmenter needs the quiet parts intact
    // to find the pauses between phrases.
    this.chain = createMicProcessingChain(mic, { highPassHz: 120, noiseGateEnabled: false });
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => this.onAudio(ev, ctx.sampleRate);
    this.chain.output.connect(this.processor);
    connectSilentSink(ctx, this.processor);
  }

  /**
   * Stop/resume sending (mute, or the agent's voice playing). Pausing also cuts
   * the segment in progress so it is transcribed now rather than merged with
   * whatever is said after the pause.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'flush' }));
    }
  }

  stop(): void {
    this.closed = true;
    this.processor?.disconnect();
    this.processor = null;
    this.chain?.dispose();
    this.chain = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(1000, 'session ended');
    }
    this.ws = null;
  }

  private onAudio(ev: AudioProcessingEvent, sampleRate: number): void {
    const ws = this.ws;
    if (this.closed || this.paused || !this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedFrames += 1;
      if (this.droppedFrames === 1 || this.droppedFrames % 50 === 0) {
        console.warn('[audio-stream] network behind — dropped', this.droppedFrames, 'frames');
      }
      return;
    }
    const pcm = downsampleTo16k(ev.inputBuffer.getChannelData(0), sampleRate);
    ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
  }
}
