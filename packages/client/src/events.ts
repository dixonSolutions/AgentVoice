/**
 * EventSocket — a reconnecting client for the bridge's multi-client desk
 * socket (`/ws/events`). Transport-agnostic: pass the WebSocket constructor of
 * the host (browser `WebSocket`, or the `ws` package in a Node extension host).
 */

import type { ApprovalResponse, DeskFrame, DeskState } from './protocol.js';

export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'unauthorized';

/** Minimal shape of a WebSocket both browsers and `ws` satisfy. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface EventSocketOptions {
  url: string;
  token: string;
  WebSocket: WebSocketCtor;
  /** Base reconnect delay (doubles up to 30 s). */
  reconnectMs?: number;
  /** Ping cadence to refresh the state snapshot; 0 disables. */
  pingMs?: number;
}

type FrameHandler = (frame: DeskFrame) => void;
type StatusHandler = (status: SocketStatus) => void;

const OPEN = 1;

export class EventSocket {
  private ws: WebSocketLike | null = null;
  private status: SocketStatus = 'disconnected';
  private readonly frameHandlers = new Set<FrameHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private wantOpen = false;
  /** Last snapshot from auth_ok / pong — status bars read this. */
  state: DeskState | null = null;

  constructor(private opts: EventSocketOptions) {}

  get currentStatus(): SocketStatus {
    return this.status;
  }

  configure(patch: Partial<Pick<EventSocketOptions, 'url' | 'token' | 'pingMs'>>): void {
    this.opts = { ...this.opts, ...patch };
  }

  onFrame(fn: FrameHandler): () => void {
    this.frameHandlers.add(fn);
    return () => this.frameHandlers.delete(fn);
  }

  onStatus(fn: StatusHandler): () => void {
    this.statusHandlers.add(fn);
    fn(this.status);
    return () => this.statusHandlers.delete(fn);
  }

  connect(): void {
    this.wantOpen = true;
    if (this.ws && this.ws.readyState === OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = new this.opts.WebSocket(this.opts.url);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.opts.token }));
    });

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let frame: DeskFrame;
      try {
        frame = JSON.parse(raw) as DeskFrame;
      } catch {
        return;
      }
      if (frame.type === 'auth_ok' || frame.type === 'pong') {
        this.state = frame as unknown as DeskState;
        if (frame.type === 'auth_ok') {
          this.attempts = 0;
          this.setStatus('connected');
          this.startPing();
        }
      }
      for (const fn of this.frameHandlers) {
        try {
          fn(frame);
        } catch {
          // a handler must never take the socket down
        }
      }
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws === ws) this.ws = null;
      this.stopPing();
      if (ev.code === 4001) {
        this.wantOpen = false;
        this.setStatus('unauthorized');
        return;
      }
      if (this.wantOpen) {
        this.setStatus('error');
        this.scheduleReconnect();
      } else {
        this.setStatus('disconnected');
      }
    });

    ws.addEventListener('error', () => {
      // `close` follows and drives the reconnect; nothing to do here.
    });
  }

  disconnect(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  /** Reconnect with (possibly) new url/token. */
  reconnect(): void {
    this.disconnect();
    this.attempts = 0;
    this.connect();
  }

  get isOpen(): boolean {
    return this.status === 'connected' && this.ws?.readyState === OPEN;
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  submitTurn(text: string, isInterrupt = false): boolean {
    return this.send({ type: 'user_turn', text, is_interrupt: isInterrupt });
  }

  respondApproval(requestId: string, response: ApprovalResponse): boolean {
    return this.send({ type: 'approval_response', request_id: requestId, response });
  }

  ping(): boolean {
    return this.send({ type: 'ping' });
  }

  private setStatus(next: SocketStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statusHandlers) fn(next);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.wantOpen) return;
    const base = this.opts.reconnectMs ?? 1500;
    const delay = Math.min(base * 2 ** Math.min(this.attempts, 4), 30_000);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const ms = this.opts.pingMs ?? 15_000;
    if (ms <= 0) return;
    this.pingTimer = setInterval(() => this.ping(), ms);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
