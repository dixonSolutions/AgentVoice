/**
 * AgentVoice for VS Code / Cursor — a desk client for the AgentVoice bridge.
 * See docs/34-vscode-extension.md.
 */

import * as vscode from 'vscode';
import { BridgeConnection, readSettings } from './bridge.js';
import { ApprovalRelay } from './approvals.js';
import { StatusBar } from './statusBar.js';
import { AgentPanel } from './panel.js';
import { Commands } from './commands.js';
import { ChangesProvider, HeadContentProvider, HEAD_SCHEME, openDiff, type ChangedFile } from './changes.js';
import { SessionsProvider } from './sessions.js';
import { VoiceSession } from './voice.js';
import { VoiceCues } from './cues.js';

/** What `activate` returns — used by the integration tests (src/test/suite.ts). */
export interface AgentVoiceApi {
  bridge: BridgeConnection;
  approvals: ApprovalRelay;
  panel: AgentPanel;
  commands: Commands;
  changes: ChangesProvider;
  sessions: SessionsProvider;
}

export async function activate(context: vscode.ExtensionContext): Promise<AgentVoiceApi> {
  const bridge = new BridgeConnection(context);
  const approvals = new ApprovalRelay(bridge);
  const panel = new AgentPanel(context, bridge, approvals);
  const statusBar = new StatusBar(bridge, approvals);
  const changes = new ChangesProvider(bridge);
  const sessions = new SessionsProvider(bridge);
  // The mic lives here, in the host — a webview has no microphone permission.
  const cues = new VoiceCues(vscode.Uri.joinPath(context.extensionUri, 'media'));
  const applyCueSetting = (): void =>
    cues.setEnabled(vscode.workspace.getConfiguration('agentvoice').get<boolean>('soundEffects') ?? true);
  applyCueSetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentvoice.soundEffects')) applyCueSetting();
    }),
  );
  const voice = new VoiceSession(bridge, cues);
  voice.isOutputPlaying = () => panel.speaking;
  context.subscriptions.push(
    voice,
    voice.onState((e) => panel.postVoice(e.state, e.detail, e.wakeWords, e.startWord)),
    voice.onLevel((level) => panel.postLevel(level)),
    voice.onHeard(({ text, ignored }) => panel.postHeard(text, ignored)),
  );
  const commands = new Commands(bridge, approvals, panel);
  // Saving bridge config must reach the running session, not wait for a restart.
  commands.onConfigSaved = () => void voice.loadConfig();

  context.subscriptions.push(
    bridge,
    approvals,
    panel,
    statusBar,
    changes,
    sessions,
    vscode.window.registerWebviewViewProvider(AgentPanel.viewType, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('agentvoice.changes', changes),
    vscode.window.registerTreeDataProvider('agentvoice.sessions', sessions),
    vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, new HeadContentProvider()),
    vscode.commands.registerCommand('agentvoice.openDiff', (file?: ChangedFile) => openDiff(file)),
    vscode.commands.registerCommand('agentvoice.selectSession', (node?: unknown) => sessions.selectSession(node as never)),
    vscode.commands.registerCommand('agentvoice.toggleVoice', () => voice.toggle()),
    vscode.commands.registerCommand('agentvoice.examineSession', (node?: unknown) => sessions.examineSession(node as never)),
    vscode.commands.registerCommand('agentvoice.refresh', async () => {
      await bridge.refreshState();
      await Promise.all([changes.refreshFromGit(), sessions.refresh()]);
    }),
    // Internal: the panel's composer submits through the same path as the commands.
    vscode.commands.registerCommand('agentvoice.__submit', (text: string) => commands.submit(text)),
  );
  commands.register(context);

  // On (re)connect: workspace → project, then MCP registration, then refresh the trees.
  let registering = false;
  context.subscriptions.push(
    bridge.onStatus((status) => {
      if (status !== 'connected' || registering) return;
      registering = true;
      void (async () => {
        try {
          if (readSettings().autoRegisterWorkspace) await commands.useWorkspaceAsProject(false);
          await bridge.refreshState();
          await Promise.all([changes.refreshFromGit(), sessions.refresh()]);
        } finally {
          registering = false;
        }
      })();
    }),
  );

  await bridge.loadToken();
  if (bridge.hasToken()) {
    await bridge.connect();
  } else {
    bridge.log('no token stored — run "AgentVoice: Set bridge token"');
  }
  return { bridge, approvals, panel, commands, changes, sessions };
}

export function deactivate(): void {
  // Disposables registered on the context handle teardown.
}
