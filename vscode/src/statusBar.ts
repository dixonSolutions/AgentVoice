/**
 * Status bar: agent · model · project · pending badge. Click → quick menu.
 */

import * as vscode from 'vscode';
import type { BridgeConnection } from './bridge.js';
import type { ApprovalRelay } from './approvals.js';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private thinking = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: BridgeConnection,
    private readonly approvals: ApprovalRelay,
  ) {
    this.item = vscode.window.createStatusBarItem('agentvoice.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'AgentVoice';
    this.item.command = 'agentvoice.statusMenu';
    this.item.show();
    this.disposables.push(
      bridge.onStatus(() => this.render()),
      bridge.onState(() => this.render()),
      approvals.onChange(() => this.render()),
      bridge.onFrame((frame) => {
        if (frame.type === 'thinking') {
          this.thinking = Boolean((frame as { value?: boolean }).value);
          this.render();
        } else if (frame.type === 'turn_complete' || frame.type === 'voice_agent_status') {
          if (frame.type === 'voice_agent_status') {
            const s = (frame as { state?: string }).state;
            if (s === 'done' || s === 'error' || s === 'stopped') this.thinking = false;
          } else {
            this.thinking = false;
          }
          this.render();
        }
      }),
    );
    this.render();
  }

  render(): void {
    const status = this.bridge.status;
    const state = this.bridge.state;
    const pending = this.approvals.pendingCount();
    const parts: string[] = [];

    if (status !== 'connected') {
      const icon = status === 'connecting' ? '$(sync~spin)' : '$(debug-disconnect)';
      this.item.text = `${icon} AgentVoice: ${status}`;
      this.item.tooltip = 'Click for options';
      this.item.backgroundColor = status === 'error' || status === 'unauthorized'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      return;
    }

    parts.push(this.thinking ? '$(sync~spin)' : state?.voice_agent ? '$(broadcast)' : '$(mic)');
    parts.push(state?.provider.displayName ?? 'Agent');
    if (state?.activeModel) {
      const effort = state.activeEffort ? ` ${state.activeEffort}` : '';
      const fast = state.activeFast ? ' fast' : '';
      parts.push(`· ${state.activeModel}${effort}${fast}`);
    }
    if (state?.activeProject) parts.push(`· ${state.activeProject}`);
    if (pending > 0) parts.push(`· $(bell-dot) ${pending}`);
    if (state && state.jobs.length > 0) parts.push(`· $(tools) ${state.jobs.length}`);

    this.item.text = parts.join(' ');
    this.item.backgroundColor = pending > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**AgentVoice** — connected to ${this.bridge.http.baseUrl}\n\n`);
    tip.appendMarkdown(`Agent: ${state?.provider.displayName ?? '?'}  \n`);
    tip.appendMarkdown(`Model: ${state?.activeModel ?? '?'}  \n`);
    tip.appendMarkdown(`Project: ${state?.activeProject ?? 'none'}  \n`);
    tip.appendMarkdown(`Permissions: ${state?.permissionMode.label ?? '?'}  \n`);
    tip.appendMarkdown(state?.voice_agent ? `Agent process: pid ${state.voice_agent.pid}\n` : 'Agent process: idle\n');
    if (pending > 0) tip.appendMarkdown(`\n**${pending} approval(s) waiting** — click to answer`);
    this.item.tooltip = tip;
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
