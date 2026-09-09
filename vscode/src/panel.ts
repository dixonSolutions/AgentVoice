/**
 * AgentPanel — the webview view in the AgentVoice side bar.
 *
 * Host side: forwards socket frames to the webview, relays turns / approval
 * answers back to the bridge, fetches bridge TTS audio (the webview cannot
 * call the bridge itself: CORS + token), and opens files the webview asks for.
 * The read-along model itself runs inside the webview (src/webview/main.ts).
 */

import * as vscode from 'vscode';
import type { ApprovalResponse, ModelsView } from '@agentvoice/client';
import { errorMessage, readSettings, type BridgeConnection } from './bridge.js';
import type { ApprovalRelay } from './approvals.js';
import { SpeechOutput } from './audioOut.js';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'turn'; text: string }
  | { type: 'approval'; request_id: string; response: ApprovalResponse }
  | { type: 'approval-detail'; request_id: string }
  | { type: 'speak'; id: string; text: string }
  | { type: 'speech-stop' }
  | { type: 'open'; path: string }
  | { type: 'command'; command: string }
  | { type: 'voice-toggle' }
  | { type: 'activity'; kind: string; text: string; path: string | null; level: string | null }
  | { type: 'controls-refresh'; reloadModels?: boolean }
  | { type: 'set-session'; sessionId: string | null }
  | { type: 'set-model'; modelId: string; effort: string | null; fast: boolean }
  | { type: 'set-permission'; id: string }
  | { type: 'log'; text: string };

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'agentvoice.panel';
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Frames received before the webview was ready (bounded). */
  private backlog: unknown[] = [];
  /**
   * models() shells out to the CLI, so it is far too expensive to re-run on
   * every state frame. Cache it and only re-ask when the provider changes or
   * the webview explicitly asks for a reload.
   */
  private modelsCache: ModelsView | null = null;
  private modelsProvider: string | null = null;
  private controlsInFlight = false;
  /** Playback lives in the host — see audioOut.ts for why. */
  private readonly speech: SpeechOutput;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeConnection,
    private readonly approvals: ApprovalRelay,
  ) {
    this.speech = new SpeechOutput(bridge);
    this.disposables.push(
      this.speech,
      this.speech.onEvent((ev) => this.post({ type: 'speech', ...ev })),
      bridge.onFrame((frame) => this.post({ type: 'frame', frame })),
      bridge.onState(() => void this.postControls()),
      bridge.onStatus((status) => {
        this.post({ type: 'status', status, baseUrl: bridge.http.baseUrl });
        if (status === 'connected') {
          void this.postControls();
          void this.postHistory();
        }
        else this.post({ type: 'controls', connected: false });
      }),
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

  /** True while the host is playing a clip — the mic must ignore it. */
  get speaking(): boolean {
    return this.speech.isPlaying;
  }

  /**
   * Replay the stored conversation into a freshly opened panel.
   *
   * Everything restored is marked read: you have already had this exchange, so
   * re-reading it aloud on every reload would be maddening.
   */
  private async postHistory(): Promise<void> {
    if (!this.view || this.bridge.status !== 'connected') return;
    const project = this.bridge.state?.activeProject;
    if (!project) return;
    try {
      const query = new URLSearchParams({ project, limit: '80' });
      const { turns } = await this.bridge.http.get<{ turns: { role: string; text: string; at: string }[] }>(
        `/api/turns?${query}`,
      );
      if (turns.length > 0) this.post({ type: 'history', turns });
    } catch (err) {
      this.bridge.log(`history load failed: ${errorMessage(err)}`);
    }
  }

  /** Show a transcript in the panel — a mishear should never be invisible. */
  postHeard(text: string, ignored = false): void {
    this.post({ type: 'heard', text, ignored });
  }

  /** Live mic loudness for the orb. Cheap and frequent — no batching needed. */
  postLevel(level: number): void {
    this.post({ type: 'level', level });
  }

  /** Mirror the host-side mic state into the panel. */
  postVoice(state: string, detail?: string, wakeWords = true, startWord: string | null = null): void {
    this.post({ type: 'voice', state, detail: detail ?? null, wakeWords, startWord });
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

  /**
   * Feed the composer's session / model / permission selects. Everything here
   * comes from the bridge, which reads it from the active CLI — no per-provider
   * lists live in this extension (docs/24).
   */
  private async postControls(opts: { reloadModels?: boolean } = {}): Promise<void> {
    if (!this.view) return;
    const state = this.bridge.state;
    if (this.bridge.status !== 'connected' || !state) {
      this.post({ type: 'controls', connected: false });
      return;
    }
    if (this.controlsInFlight) return;
    this.controlsInFlight = true;
    try {
      const project = state.activeProject;
      const providerId = state.provider.id;
      const staleModels = this.modelsCache === null || this.modelsProvider !== providerId;
      const [sessions, models, permissions] = await Promise.all([
        project ? this.bridge.http.sessions(project).catch(() => null) : Promise.resolve(null),
        opts.reloadModels || staleModels
          ? this.bridge.http.models().catch(() => null)
          : Promise.resolve(this.modelsCache),
        this.bridge.http.permissionModes().catch(() => null),
      ]);
      if (models) {
        this.modelsCache = models;
        this.modelsProvider = providerId;
      }
      this.post({
        type: 'controls',
        connected: true,
        project,
        provider: state.provider.displayName,
        sessions: sessions?.sessions ?? [],
        activeSession: sessions?.active_session_id ?? null,
        models: models?.models ?? [],
        activeModel: state.activeModel,
        activeEffort: state.activeEffort ?? null,
        activeFast: state.activeFast === true,
        modes: permissions?.modes ?? [],
        activeMode: permissions?.active.id ?? state.permissionMode.id,
      });
    } finally {
      this.controlsInFlight = false;
    }
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
          void this.postControls();
          void this.postHistory();
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
        case 'speak':
          await this.speech.speak(msg.id, msg.text);
          return;
        case 'speech-stop':
          this.speech.stop();
          return;
        case 'open': {
          const uri = vscode.Uri.file(msg.path);
          await vscode.window.showTextDocument(uri, { preview: true });
          return;
        }
        case 'command':
          await vscode.commands.executeCommand(msg.command);
          return;
        case 'voice-toggle':
          await vscode.commands.executeCommand('agentvoice.toggleVoice');
          return;
        case 'controls-refresh':
          await this.postControls({ reloadModels: msg.reloadModels === true });
          return;
        case 'set-session': {
          const project = this.bridge.state?.activeProject;
          if (!project) {
            void vscode.window.showInformationMessage('AgentVoice: pick a project first.');
            return;
          }
          // null means "start a fresh thread" — the default for a new turn.
          const result = msg.sessionId
            ? await this.bridge.http.selectSession(project, msg.sessionId)
            : await this.bridge.http.newSession(project);
          this.bridge.log(`session: ${result.message}`);
          await this.bridge.refreshState();
          await this.postControls();
          return;
        }
        case 'set-model':
          await this.bridge.http.setModel({ model_id: msg.modelId, effort: msg.effort, fast: msg.fast });
          await this.bridge.refreshState();
          await this.postControls();
          return;
        case 'set-permission':
          await this.bridge.http.setPermissionMode(msg.id);
          await this.bridge.refreshState();
          await this.postControls();
          return;
        case 'activity': {
          // Absolute paths make the output channel linkify the file.
          const where = msg.path ? ` (${msg.path})` : '';
          this.bridge.log(`${msg.level === 'error' ? '! ' : ''}${msg.kind}: ${msg.text}${where}`);
          return;
        }
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
<footer id="foot">
  <div id="thinking" class="thinking" hidden><span class="dot"></span> thinking…</div>
  <div id="controls" class="controls" hidden>
    <label class="ctl"><span class="ctl-label">Session</span>
      <select id="ctl-session" title="Which CLI thread this turn continues"></select>
    </label>
    <label class="ctl"><span class="ctl-label">Model</span>
      <select id="ctl-model" title="Model, read live from the active CLI"></select>
    </label>
    <label class="ctl" id="ctl-effort-wrap" hidden><span class="ctl-label">Effort</span>
      <select id="ctl-effort"></select>
    </label>
    <label class="ctl ctl-check" id="ctl-fast-wrap" hidden>
      <input type="checkbox" id="ctl-fast"><span class="ctl-label">Fast</span>
    </label>
    <label class="ctl" id="ctl-perm-wrap"><span class="ctl-label">Permissions</span>
      <select id="ctl-perm" title="Permission mode, applied on the next spawn"></select>
    </label>
  </div>
  <!-- The orb is the input. No prompt box: typing is the exception, behind the pen. -->
  <div class="orbstage" id="orbstage">
    <canvas id="orb" aria-hidden="true"></canvas>
    <button id="orbhit" class="orbhit" title="Start a voice session"></button>
    <div id="orb-label" class="orb-label">Tap to start</div>
    <button id="pen" class="pen" title="Type a turn instead">✎</button>
  </div>
  <div class="tools">
    <button id="stop" class="link" title="Interrupt the agent">stop</button>
    <button id="markread" class="link" title="Mark everything as read">mark read</button>
    <span id="audio-state" class="muted"></span>
  </div>
</footer>
<div id="penbox" class="penbox" hidden>
  <div class="penbox-card">
    <div class="penbox-head">Type a turn</div>
    <textarea id="input" rows="3" placeholder="Message the agent…" title="Enter to send, Shift+Enter for a newline"></textarea>
    <div class="penbox-actions">
      <button id="pencancel" class="link">Cancel</button>
      <button id="send" class="primary">Send turn</button>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
