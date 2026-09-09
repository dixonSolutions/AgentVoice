/**
 * BridgeConnection — one object the rest of the extension talks to.
 *
 * Owns the REST client, the `/ws/events` socket, the current desk snapshot
 * and the token (SecretStorage). Every UI piece subscribes to `onFrame`,
 * `onStatus` and `onState` instead of touching the socket.
 */

import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
  BridgeHttp,
  EventSocket,
  type DeskFrame,
  type DeskState,
  type SocketStatus,
  type WebSocketCtor,
} from '@agentvoice/client';

const TOKEN_KEY = 'agentvoice.token';

export interface ExtensionSettings {
  bridgeUrl: string;
  autoRegisterWorkspace: boolean;
  prepareOnConnect: boolean;
  readAloud: 'off' | 'bridge' | 'browser';
  pacer: boolean;
  notifications: boolean;
  contextMaxChars: number;
}

export function readSettings(): ExtensionSettings {
  const cfg = vscode.workspace.getConfiguration('agentvoice');
  return {
    bridgeUrl: (cfg.get<string>('bridgeUrl') ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    autoRegisterWorkspace: cfg.get<boolean>('autoRegisterWorkspace') ?? true,
    prepareOnConnect: cfg.get<boolean>('prepareOnConnect') ?? true,
    readAloud: cfg.get<'off' | 'bridge' | 'browser'>('readAloud') ?? 'off',
    pacer: cfg.get<boolean>('pacer') ?? true,
    notifications: cfg.get<boolean>('notifications') ?? true,
    contextMaxChars: cfg.get<number>('contextMaxChars') ?? 12000,
  };
}

export class BridgeConnection implements vscode.Disposable {
  readonly http: BridgeHttp;
  readonly socket: EventSocket;
  readonly output: vscode.OutputChannel;

  private readonly frameEmitter = new vscode.EventEmitter<DeskFrame>();
  private readonly statusEmitter = new vscode.EventEmitter<SocketStatus>();
  private readonly stateEmitter = new vscode.EventEmitter<DeskState>();
  readonly onFrame = this.frameEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  readonly onState = this.stateEmitter.event;

  private disposables: vscode.Disposable[] = [];
  private token = '';
  /** Workspace project registered this session (name), if any. */
  workspaceProject: { name: string; path: string; ephemeral: boolean } | null = null;
  /** True once MCP registration ran for this connection. */
  prepared = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('AgentVoice');
    const settings = readSettings();
    this.http = new BridgeHttp({ baseUrl: settings.bridgeUrl, token: '' });
    this.socket = new EventSocket({
      url: this.http.eventsUrl(),
      token: '',
      WebSocket: WebSocket as unknown as WebSocketCtor,
      pingMs: 20_000,
    });
    this.socket.onFrame((frame) => {
      if (frame.type === 'auth_ok' || frame.type === 'pong') {
        this.stateEmitter.fire(frame as unknown as DeskState);
      }
      this.frameEmitter.fire(frame);
    });
    this.socket.onStatus((status) => {
      this.log(`socket: ${status}`);
      this.statusEmitter.fire(status);
      if (status === 'unauthorized') {
        void vscode.window
          .showErrorMessage('AgentVoice: the bridge rejected the token.', 'Set token')
          .then((pick) => pick && vscode.commands.executeCommand('agentvoice.setToken'));
      }
    });
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentvoice.bridgeUrl')) void this.connect();
      }),
    );
  }

  get state(): DeskState | null {
    return this.socket.state;
  }

  get status(): SocketStatus {
    return this.socket.currentStatus;
  }

  log(line: string): void {
    this.output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  }

  async loadToken(): Promise<string> {
    this.token = (await this.context.secrets.get(TOKEN_KEY)) ?? '';
    return this.token;
  }

  async setToken(token: string): Promise<void> {
    this.token = token.trim();
    await this.context.secrets.store(TOKEN_KEY, this.token);
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  /** (Re)connect with current settings + token. Prompts for a token when missing. */
  async connect(): Promise<boolean> {
    const settings = readSettings();
    if (!this.token) await this.loadToken();
    if (!this.token) {
      const pick = await vscode.window.showInformationMessage(
        'AgentVoice needs the bridge APP_TOKEN (from the bridge .env).',
        'Set token',
      );
      if (pick === 'Set token') await vscode.commands.executeCommand('agentvoice.setToken');
      if (!this.token) return false;
    }
    this.http.configure({ baseUrl: settings.bridgeUrl, token: this.token });
    this.socket.configure({ url: this.http.eventsUrl(), token: this.token });
    this.prepared = false;
    this.workspaceProject = null;
    this.log(`connecting to ${settings.bridgeUrl}`);
    this.socket.reconnect();
    return true;
  }

  /** Refresh the desk snapshot over REST (e.g. after a picker changes something). */
  async refreshState(): Promise<DeskState | null> {
    try {
      const state = await this.http.agentState();
      this.socket.state = state;
      this.stateEmitter.fire(state);
      return state;
    } catch (err) {
      this.log(`state refresh failed: ${errorMessage(err)}`);
      return null;
    }
  }

  dispose(): void {
    this.socket.disconnect();
    for (const d of this.disposables) d.dispose();
    this.frameEmitter.dispose();
    this.statusEmitter.dispose();
    this.stateEmitter.dispose();
    this.output.dispose();
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
