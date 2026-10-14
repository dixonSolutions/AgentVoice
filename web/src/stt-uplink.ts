/**
 * The phone side of /ws/stt — a turn's mic audio sent while it is spoken.
 *
 * Each chunk the mic produces goes to the bridge the moment it is captured,
 * so when the speaker stops the utterance is already there: a live engine has
 * been transcribing it all along, and any other engine starts at once instead
 * of after an upload. The socket stays open for the session; if it drops and
 * comes back mid-utterance, everything captured so far is sent again.
 *
 * `finish()` rejects with SttUplinkUnavailable when the socket cannot carry
 * the utterance (no connection, an older bridge without /ws/stt, a drop after
 * `end`). The caller then POSTs the audio it kept — the old path. An `error`
 * from the bridge is the engine's answer and is not retried.
 */

export class SttUplinkUnavailable extends Error {
  constructor(reason: string) {
    super(`Live upload unavailable: ${reason}`);
    this.name = 'SttUplinkUnavailable';
  }
}

export interface SttUplinkResult {
  text: string;
  provider: string | null;
  live: boolean;
}

/** The parts of WebSocket this needs — the browser's, or `ws` in tests. */
export interface UplinkSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}

export type UplinkSocketFactory = (url: string) => UplinkSocket;

const OPEN = 1;
const PING_MS = 25_000;
const FINISH_TIMEOUT_MS = 45_000;
/** Stop retrying a bridge that refuses /ws/stt (older bridge, proxy without it). */
const MAX_FAILED_CONNECTS = 3;

interface Pending {
  resolve(result: SttUplinkResult): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SttUplink {
  private ws: UplinkSocket | null = null;
  private ready = false;
  private closed = false;
  private failedConnects = 0;
  private seq = 0;
  private current: { id: string; chunks: Int16Array[] } | null = null;
  private readonly pending = new Map<string, Pending>();
  private ping: ReturnType<typeof setInterval> | null = null;
  /** The bridge's primary engine transcribes while you speak. */
  live = false;

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly openSocket: UplinkSocketFactory = (url) => new WebSocket(url) as unknown as UplinkSocket,
  ) {}

  /** Open (or re-open) the socket. Safe to call repeatedly. */
  connect(): void {
    if (this.closed || this.failedConnects >= MAX_FAILED_CONNECTS) return;
    if (this.ws && this.ws.readyState <= OPEN) return;
    const url = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/stt`;
    let ws: UplinkSocket;
    try {
      ws = this.openSocket(url);
    } catch {
      this.failedConnects += 1;
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let authed = false;

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
      if (msg['type'] === 'auth_ok') {
        authed = true;
        this.failedConnects = 0;
        this.ready = true;
        this.live = msg['live'] === true;
        this.startPing();
        this.replayCurrent();
        return;
      }
      this.onReply(msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      if (!authed) this.failedConnects += 1;
      this.ws = null;
      this.ready = false;
      this.stopPing();
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new SttUplinkUnavailable('connection closed'));
        this.pending.delete(id);
      }
    });
    ws.addEventListener('error', () => undefined);
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** A new utterance starts — drops one still open. */
  begin(): void {
    if (this.current) this.cancel();
    this.current = { id: `u${Date.now().toString(36)}-${++this.seq}`, chunks: [] };
    if (this.ready) this.sendBegin(this.current.id);
    else this.connect();
  }

  /** One captured chunk (16 kHz mono PCM16) — sent now if the socket is up. */
  send(pcm: Int16Array): void {
    if (!this.current) return;
    this.current.chunks.push(pcm);
    if (this.ready) this.sendAudio(pcm);
  }

  /** The speaker stopped: resolves with the transcript. */
  finish(timeoutMs = FINISH_TIMEOUT_MS): Promise<SttUplinkResult> {
    const turn = this.current;
    this.current = null;
    if (!turn) return Promise.reject(new SttUplinkUnavailable('no utterance open'));
    if (!this.ready || !this.ws) return Promise.reject(new SttUplinkUnavailable('not connected'));
    const ws = this.ws;
    return new Promise<SttUplinkResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(turn.id);
        reject(new Error('Transcription timed out'));
      }, timeoutMs);
      this.pending.set(turn.id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'end', id: turn.id }));
    });
  }

  /** Throw the open utterance away, and any still being transcribed. */
  cancel(): void {
    const turn = this.current;
    this.current = null;
    if (turn && this.ready) this.ws?.send(JSON.stringify({ type: 'cancel', id: turn.id }));
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (this.ready) this.ws?.send(JSON.stringify({ type: 'cancel', id }));
      p.reject(new DOMException('Transcription cancelled', 'AbortError'));
    }
  }

  close(): void {
    this.closed = true;
    this.cancel();
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws && ws.readyState <= OPEN) ws.close(1000, 'session ended');
  }

  private sendBegin(id: string): void {
    this.ws?.send(JSON.stringify({ type: 'begin', id, sampleRate: 16_000, encoding: 'pcm_s16le', channels: 1 }));
  }

  private sendAudio(pcm: Int16Array): void {
    this.ws?.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
  }

  /** (Re)connected mid-utterance: the bridge gets all of it, from the start. */
  private replayCurrent(): void {
    const turn = this.current;
    if (!turn) return;
    this.sendBegin(turn.id);
    for (const pcm of turn.chunks) this.sendAudio(pcm);
  }

  private onReply(msg: Record<string, unknown>): void {
    const id = typeof msg['id'] === 'string' ? msg['id'] : '';
    const p = id ? this.pending.get(id) : undefined;
    if (!p) return;
    if (msg['type'] === 'transcript') {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({
        text: typeof msg['text'] === 'string' ? msg['text'] : '',
        provider: typeof msg['provider'] === 'string' ? msg['provider'] : null,
        live: msg['live'] === true,
      });
    } else if (msg['type'] === 'error') {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(typeof msg['message'] === 'string' ? msg['message'] : 'Transcription failed'));
    }
  }

  private startPing(): void {
    this.stopPing();
    // Between turns nothing else crosses this socket; keep proxies from reaping it.
    this.ping = setInterval(() => {
      if (this.ready) this.ws?.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.ping !== null) clearInterval(this.ping);
    this.ping = null;
  }
}
