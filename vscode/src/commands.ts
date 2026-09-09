/**
 * Commands: send editor context, pickers, session control.
 * Everything goes through the bridge — no CLI-specific logic here.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ApprovalRequest, ModelEntry } from '@agentvoice/client';
import { errorMessage, readSettings, type BridgeConnection } from './bridge.js';
import type { ApprovalRelay } from './approvals.js';
import type { AgentPanel } from './panel.js';

function workspaceRelative(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`, clipped: true };
}

export class Commands {
  constructor(
    private readonly bridge: BridgeConnection,
    private readonly approvals: ApprovalRelay,
    private readonly panel: AgentPanel,
  ) {}

  register(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown): void => {
      context.subscriptions.push(vscode.commands.registerCommand(id, (...args) => this.guard(() => fn(...args))));
    };
    reg('agentvoice.connect', () => this.bridge.connect());
    reg('agentvoice.setToken', () => this.setToken());
    reg('agentvoice.openPanel', () => this.panel.reveal());
    reg('agentvoice.ask', () => this.ask());
    reg('agentvoice.sendSelection', () => this.sendSelection());
    reg('agentvoice.sendFile', () => this.sendFile());
    reg('agentvoice.sendDiagnostics', () => this.sendDiagnostics());
    reg('agentvoice.useWorkspaceAsProject', () => this.useWorkspaceAsProject(true));
    reg('agentvoice.pickProject', () => this.pickProject());
    reg('agentvoice.pickModel', () => this.pickModel());
    reg('agentvoice.pickPermissionMode', () => this.pickPermissionMode());
    reg('agentvoice.newSession', () => this.newSession());
    reg('agentvoice.stopAgent', () => this.stopAgent());
    reg('agentvoice.answerApproval', (arg) => this.answerApproval(arg));
    reg('agentvoice.statusMenu', () => this.statusMenu());
    reg('agentvoice.markAllRead', () => this.panel.markAllRead());
    reg('agentvoice.revert', () => this.revert());
    reg('agentvoice.showDiffAll', () => this.showDiffAll());
  }

  private async guard(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = errorMessage(err);
      this.bridge.log(`command failed: ${message}`);
      void vscode.window.showErrorMessage(`AgentVoice: ${message}`);
    }
  }

  private requireConnected(): boolean {
    if (this.bridge.status === 'connected') return true;
    void vscode.window
      .showWarningMessage('AgentVoice is not connected to the bridge.', 'Connect')
      .then((pick) => pick && this.bridge.connect());
    return false;
  }

  async setToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'AgentVoice bridge token',
      prompt: 'APP_TOKEN from the bridge .env',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;
    await this.bridge.setToken(token);
    await this.bridge.connect();
  }

  /** Submit a turn: socket first, REST fallback. Shows it in the panel. */
  async submit(text: string): Promise<void> {
    if (!this.requireConnected()) return;
    if (!this.bridge.state?.activeProject) {
      const registered = await this.useWorkspaceAsProject(false);
      if (!registered) {
        await this.pickProject();
        if (!this.bridge.state?.activeProject) return;
      }
    }
    await this.ensurePrepared();
    this.panel.reveal();
    if (!this.bridge.socket.submitTurn(text)) {
      await this.bridge.http.submitTurn(text, { source: 'desk' });
      this.panel.localUserTurn(text);
    }
  }

  async ask(prefill = ''): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: 'Ask the agent',
      prompt: 'Sent as a turn to the active agent (spawns it if idle)',
      value: prefill,
      ignoreFocusOut: true,
    });
    if (text?.trim()) await this.submit(text.trim());
  }

  async sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select some code first.');
      return;
    }
    const { contextMaxChars } = readSettings();
    const sel = editor.selection;
    const body = clip(editor.document.getText(sel), contextMaxChars);
    const rel = workspaceRelative(editor.document.uri);
    const note = await vscode.window.showInputBox({
      title: `Send selection (${rel}:${sel.start.line + 1}-${sel.end.line + 1})`,
      prompt: 'What should the agent do with it?',
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    const prompt =
      `${note.trim() || 'Look at this selection.'}\n\n` +
      `File: ${rel} (lines ${sel.start.line + 1}-${sel.end.line + 1})\n` +
      fence(editor.document.languageId, body.text);
    await this.submit(prompt);
  }

  async sendFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file first.');
      return;
    }
    const rel = workspaceRelative(editor.document.uri);
    const { contextMaxChars } = readSettings();
    const body = clip(editor.document.getText(), contextMaxChars);
    const note = await vscode.window.showInputBox({
      title: `Send ${rel}`,
      prompt: 'What should the agent do with this file? (the path is enough for it to open the file itself)',
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    const includeBody =
      body.text.length <= 4000
        ? true
        : (await vscode.window.showQuickPick(['Path only', 'Path + contents'], { title: 'Attach file contents?' })) === 'Path + contents';
    const prompt =
      `${note.trim() || `Look at ${rel}.`}\n\nFile: ${rel}` + (includeBody ? `\n${fence(editor.document.languageId, body.text)}` : '');
    await this.submit(prompt);
  }

  async sendDiagnostics(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file first.');
      return;
    }
    const rel = workspaceRelative(editor.document.uri);
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    if (diags.length === 0) {
      void vscode.window.showInformationMessage(`No diagnostics in ${rel}.`);
      return;
    }
    const lines = diags.slice(0, 50).map((d) => {
      const sev = vscode.DiagnosticSeverity[d.severity].toLowerCase();
      const code = d.code === undefined ? '' : ` ${String(typeof d.code === 'object' ? d.code.value : d.code)}`;
      const src = d.source ? ` [${d.source}${code}]` : '';
      return `- ${sev} L${d.range.start.line + 1}:${d.range.start.character + 1}${src} ${d.message}`;
    });
    const prompt =
      `Fix the following diagnostics in ${rel}. Open the file yourself and make the edits.\n\n` +
      lines.join('\n') +
      (diags.length > 50 ? `\n… and ${diags.length - 50} more` : '');
    await this.submit(prompt);
  }

  /** Make the first workspace folder the active project. Returns true when a project is active afterwards. */
  async useWorkspaceAsProject(interactive: boolean): Promise<boolean> {
    if (!this.requireConnected()) return false;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      if (interactive) void vscode.window.showInformationMessage('Open a folder first.');
      return false;
    }
    if (folder.uri.scheme !== 'file') {
      if (interactive) void vscode.window.showWarningMessage('AgentVoice needs a local folder — remote workspaces are not supported (docs/32).');
      return false;
    }
    try {
      const result = await this.bridge.http.registerWorkspace({ path: folder.uri.fsPath, activate: true });
      this.bridge.workspaceProject = { name: result.project.name, path: result.project.path, ephemeral: result.project.ephemeral };
      await this.bridge.refreshState();
      this.bridge.log(
        `workspace project: ${result.project.name} (${result.project.ephemeral ? 'ephemeral' : 'from config.json'}${result.created ? ', created' : ''})`,
      );
      if (interactive) {
        void vscode.window.showInformationMessage(
          `AgentVoice: active project is now "${result.project.name}"${result.project.ephemeral ? ' (this folder, not saved to config.json)' : ''}.`,
        );
      }
      return true;
    } catch (err) {
      if (interactive) throw err;
      this.bridge.log(`workspace registration failed: ${errorMessage(err)}`);
      return false;
    }
  }

  private async ensurePrepared(): Promise<void> {
    if (this.bridge.prepared || !readSettings().prepareOnConnect) return;
    const project = this.bridge.state?.activeProject;
    if (!project) return;
    try {
      await this.bridge.http.prepare(project);
      this.bridge.prepared = true;
      this.bridge.log(`MCP registration prepared for ${project}`);
    } catch (err) {
      this.bridge.log(`prepare failed: ${errorMessage(err)}`);
      void vscode.window.showWarningMessage(`AgentVoice: MCP registration failed — ${errorMessage(err)}`);
    }
  }

  async pickProject(): Promise<void> {
    if (!this.requireConnected()) return;
    const projects = await this.bridge.http.projects();
    const items: vscode.QuickPickItem[] = projects.map((p) => ({
      label: p.name,
      description: p.description ?? undefined,
      detail: p.aliases.length ? `aliases: ${p.aliases.join(', ')}` : undefined,
    }));
    items.unshift({ label: '$(folder) This workspace', description: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', detail: 'workspace' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Active project', placeHolder: this.bridge.state?.activeProject ?? undefined });
    if (!pick) return;
    if (pick.detail === 'workspace') {
      await this.useWorkspaceAsProject(true);
      return;
    }
    await this.bridge.http.setActiveProject(pick.label);
    await this.bridge.refreshState();
  }

  async pickModel(): Promise<void> {
    if (!this.requireConnected()) return;
    const view = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AgentVoice: loading models from the CLI…' },
      () => this.bridge.http.models(),
    );
    const models: ModelEntry[] = view.models ?? [];
    if (models.length === 0) {
      void vscode.window.showInformationMessage('The active CLI reported no models.');
      return;
    }
    const items = models.map((m) => ({
      label: m.displayName || m.id,
      description: m.id === view.active_model ? '$(check) active' : m.vendor,
      detail: [m.description, m.efforts?.length ? `effort: ${m.efforts.join(' / ')}` : null, m.fast ? 'fast tier' : null]
        .filter(Boolean)
        .join(' · '),
      model: m,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: `Model (${this.bridge.state?.provider.displayName ?? 'agent'})`, matchOnDetail: true });
    if (!pick) return;
    const m = pick.model;
    let effort: string | null | undefined;
    if (m.efforts?.length) {
      const e = await vscode.window.showQuickPick(
        [{ label: 'CLI default', id: null as string | null }, ...m.efforts.map((x) => ({ label: x, id: x as string | null }))],
        { title: `Effort for ${pick.label}` },
      );
      if (!e) return;
      effort = e.id;
    }
    let fast = false;
    if (m.fast) {
      const f = await vscode.window.showQuickPick(['Standard', 'Fast'], { title: 'Speed tier' });
      if (!f) return;
      fast = f === 'Fast';
    }
    await this.bridge.http.setModel({ model_id: m.id, effort: effort ?? null, fast });
    await this.bridge.refreshState();
  }

  async pickPermissionMode(): Promise<void> {
    if (!this.requireConnected()) return;
    const view = await this.bridge.http.permissionModes();
    if (view.modes.length <= 1) {
      void vscode.window.showInformationMessage(`${view.displayName} has a single permission mode: ${view.active.label}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      view.modes.map((m) => ({
        label: m.label,
        description: m.id === view.active.id ? '$(check) active' : m.id,
        detail: `${m.description} — prompts: ${m.prompts === 'phone' ? 'relayed here and to the phone' : m.prompts === 'deny' ? 'refused' : 'never'}`,
        id: m.id,
      })),
      { title: `Permission mode (${view.displayName})`, matchOnDetail: true },
    );
    if (!pick) return;
    await this.bridge.http.setPermissionMode(pick.id);
    await this.bridge.refreshState();
    void vscode.window.showInformationMessage(`AgentVoice: ${view.displayName} will run in "${pick.label}" from the next spawn.`);
  }

  async newSession(): Promise<void> {
    if (!this.requireConnected()) return;
    const project = this.bridge.state?.activeProject;
    if (!project) {
      void vscode.window.showInformationMessage('Pick a project first.');
      return;
    }
    const result = await this.bridge.http.newSession(project);
    void vscode.window.showInformationMessage(`AgentVoice: ${result.message}`);
    await this.bridge.refreshState();
  }

  async stopAgent(): Promise<void> {
    if (!this.requireConnected()) return;
    const state = this.bridge.state;
    const targets: vscode.QuickPickItem[] = [];
    if (state?.voice_agent) targets.push({ label: '$(broadcast) Conversational agent', description: `pid ${state.voice_agent.pid}`, detail: 'voice' });
    for (const j of state?.jobs ?? []) targets.push({ label: `$(tools) Job ${j.jobId}`, description: j.prompt, detail: j.jobId });
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('Nothing is running.');
      return;
    }
    const pick = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: 'Stop which agent?' });
    if (!pick) return;
    if (pick.detail === 'voice') {
      // The bridge's stop path for the conversational loop is a spoken/typed interrupt turn.
      await this.bridge.http.submitTurn('stop', { is_interrupt: true, source: 'desk' });
      void vscode.window.showInformationMessage('AgentVoice: stop request sent to the agent.');
      return;
    }
    await this.bridge.http.tool('agent_job_stop', { job_id: pick.detail });
    await this.bridge.refreshState();
  }

  async answerApproval(arg: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : (arg as { request_id?: string } | undefined)?.request_id;
    const list = this.approvals.list();
    const req = id ? this.approvals.get(id) : list.length === 1 ? list[0] : undefined;
    if (req) return this.approvals.prompt(req);
    if (list.length === 0) {
      void vscode.window.showInformationMessage('No approvals are waiting.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      list.map((r) => ({ label: describeApproval(r), id: r.request_id })),
      { title: 'Pending approvals' },
    );
    if (pick) {
      const chosen = this.approvals.get(pick.id);
      if (chosen) await this.approvals.prompt(chosen);
    }
  }

  async statusMenu(): Promise<void> {
    const state = this.bridge.state;
    const items: Array<vscode.QuickPickItem & { cmd: string }> = [];
    if (this.approvals.pendingCount() > 0) {
      items.push({ label: `$(bell-dot) Answer ${this.approvals.pendingCount()} pending approval(s)`, cmd: 'agentvoice.answerApproval' });
    }
    if (this.bridge.status !== 'connected') items.push({ label: '$(plug) Connect', cmd: 'agentvoice.connect' });
    items.push(
      { label: '$(comment-discussion) Open agent panel', cmd: 'agentvoice.openPanel' },
      { label: '$(send) Ask the agent…', cmd: 'agentvoice.ask' },
      { label: `$(folder) Project: ${state?.activeProject ?? 'none'}`, description: 'switch', cmd: 'agentvoice.pickProject' },
      { label: `$(circuit-board) Model: ${state?.activeModel ?? '?'}`, description: 'choose', cmd: 'agentvoice.pickModel' },
      { label: `$(shield) Permissions: ${state?.permissionMode.label ?? '?'}`, description: 'change', cmd: 'agentvoice.pickPermissionMode' },
      { label: '$(history) New session (fresh thread)', cmd: 'agentvoice.newSession' },
      { label: '$(debug-stop) Stop the agent', cmd: 'agentvoice.stopAgent' },
      { label: '$(key) Set bridge token', cmd: 'agentvoice.setToken' },
      { label: '$(output) Show log', cmd: '__log' },
    );
    const pick = await vscode.window.showQuickPick(items, { title: `AgentVoice — ${this.bridge.status}` });
    if (!pick) return;
    if (pick.cmd === '__log') this.bridge.output.show(true);
    else await vscode.commands.executeCommand(pick.cmd);
  }

  async revert(): Promise<void> {
    if (!this.requireConnected()) return;
    const ok = await vscode.window.showWarningMessage(
      'Stash all uncommitted changes in the active project? (git stash — reversible with git stash pop)',
      { modal: true },
      'Stash changes',
    );
    if (!ok) return;
    const result = await this.bridge.http.tool<{ message?: string; files?: string[]; method?: string }>('agent_revert', { confirm: false });
    void vscode.window.showInformationMessage(`AgentVoice: ${result.message ?? `${result.method}: ${result.files?.length ?? 0} files`}`);
  }

  async showDiffAll(): Promise<void> {
    if (!this.requireConnected()) return;
    const diff = await this.bridge.http.diff(true);
    const doc = await vscode.workspace.openTextDocument({
      language: 'diff',
      content: diff.clean ? '# No uncommitted changes.\n' : `# ${diff.project}\n# ${diff.diffstat.replace(/\n/g, '\n# ')}\n\n${diff.patch ?? ''}`,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

export function describeApproval(r: ApprovalRequest): string {
  switch (r.kind) {
    case 'permission':
      return `$(shield) ${r.provider}: ${r.summary}`;
    case 'user_input':
      return `$(question) ${r.question}`;
    case 'plan_approval':
      return `$(list-ordered) Plan: ${r.title}`;
    case 'secret_input':
      return `$(key) Password (${r.source})`;
  }
}
