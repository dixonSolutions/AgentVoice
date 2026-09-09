/**
 * AgentPanel — the webview view in the AgentVoice side bar.
 *
 * Host side: forwards socket frames to the webview, relays turns / approval
 * answers back to the bridge, fetches bridge TTS audio (the webview cannot
 * call the bridge itself: CORS + token), and opens files the webview asks for.
 * The read-along model itself runs inside the webview (src/webview/main.ts).
 */

import * as vscode from 'vscode';
import type { ApprovalResponse } from '@agentvoice/client';
import { errorMessage, readSettings, type BridgeConnection } from './bridge.js';
import type { ApprovalRelay } from './approvals.js';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'turn'; text: string }
  | { type: 'approval'; request_id: string; response: ApprovalResponse }
  | { type: 'approval-detail'; request_id: string }
  | { type: 'tts'; id: string; text: string }
  | { type: 'open'; path: string }
  | { type: 'command'; command: string }
  | { type: 'log'; text: string };

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'agentvoice.panel';
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Frames received before the webview was ready (bounded). */
  private backlog: unknown[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeConnection,
    private readonly approvals: ApprovalRelay,
  ) {
    this.disposables.push(
      bridge.onFrame((frame) => this.post({ type: 'frame', frame })),
      bridge.onStatus((status) => this.post({ type: 'status', status, baseUrl: bridge.http.baseUrl })),
      approvals.onChange((list) => this.post({ type: 'approvals', list })),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentvoice')) this.postConfig();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand('agentvoice.panel.focus');
    }
  }

  markAllRead(): void {
    this.post({ type: 'markAllRead' });
  }

  /** A turn that went over REST (socket down) still shows in the transcript. */
  localUserTurn(text: string): void {
    this.post({ type: 'frame', frame: { type: 'user_turn', text, source: 'desk', delivery: 'rest', run_id: null } });
  }

  private post(message: unknown): void {
    if (!this.view) {
      this.backlog.push(message);
      if (this.backlog.length > 300) this.backlog.shift();
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private postConfig(): void {
    const s = readSettings();
    this.post({ type: 'config', readAloud: s.readAloud, pacer: s.pacer });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          this.postConfig();
          this.post({ type: 'status', status: this.bridge.status, baseUrl: this.bridge.http.baseUrl });
          if (this.bridge.state) this.post({ type: 'frame', frame: { type: 'pong', ...this.bridge.state } });
          this.post({ type: 'approvals', list: this.approvals.list() });
          for (const m of this.backlog) void this.view?.webview.postMessage(m);
          this.backlog = [];
          return;
        }
        case 'turn':
          await vscode.commands.executeCommand('agentvoice.__submit', msg.text);
          return;
        case 'approval':
          await this.approvals.respond(msg.request_id, msg.response);
          return;
        case 'approval-detail': {
          const req = this.approvals.get(msg.request_id);
          if (req) await this.approvals.prompt(req);
          return;
        }
        case 'tts': {
          try {
            const out = await this.bridge.http.tts(msg.text);
            this.post({ type: 'tts', id: msg.id, audio: Buffer.from(out.audio).toString('base64'), contentType: out.contentType, provider: out.provider });
          } catch (err) {
            this.post({ type: 'tts', id: msg.id, error: errorMessage(err) });
          }
          return;
        }
        case 'open': {
          const uri = vscode.Uri.file(msg.path);
          await vscode.window.showTextDocument(uri, { preview: true });
          return;
        }
        case 'command':
          await vscode.commands.executeCommand(msg.command);
          return;
        case 'log':
          this.bridge.log(`webview: ${msg.text}`);
          return;
      }
    } catch (err) {
      this.bridge.log(`panel message failed: ${errorMessage(err)}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    // media-src blob: → bridge TTS audio arrives as base64 and plays from a Blob URL.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      'img-src data: https:',
      'media-src blob: data:',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>AgentVoice</title>
</head>
<body>
<header id="head">
  <div id="conn" class="conn">connecting…</div>
  <div id="meta" class="meta"></div>
  <div class="progress"><div id="bar" class="bar"></div></div>
</header>
<section id="approvals" class="approvals" hidden></section>
<main id="page" class="page" aria-live="polite"></main>
<section id="activity" class="activity" hidden>
  <div class="activity-head">Activity <button id="activity-clear" class="link">clear</button></div>
  <ul id="activity-list"></ul>
</section>
<footer id="foot">
  <div id="thinking" class="thinking" hidden><span class="dot"></span> thinking…</div>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="Type to the agent… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send" class="primary" title="Send">Send</button>
  </div>
  <div class="tools">
    <button id="stop" class="link" title="Interrupt the agent">stop</button>
    <button id="read" class="link" title="Read the unread lines aloud">read aloud</button>
    <button id="markread" class="link" title="Mark everything as read">mark read</button>
    <span id="audio-state" class="muted"></span>
  </div>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
