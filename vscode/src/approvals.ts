/**
 * ApprovalRelay — the CLI's permission prompts, the agent's questions, plan
 * reviews and sudo/git/ssh password prompts as native editor UI.
 *
 * Every pending request lives in `pending` (the panel renders them too);
 * notifications are optional. Whoever answers first wins — the bridge sends
 * `approval_cancelled` and the card disappears everywhere.
 *
 * Editor notifications cannot be dismissed programmatically, so a stale
 * notification whose request was already answered on the phone reports that
 * on click instead of failing silently.
 */

import * as vscode from 'vscode';
import { approvalFromPush, type ApprovalRequest, type ApprovalResponse } from '@agentvoice/client';
import { errorMessage, readSettings, type BridgeConnection } from './bridge.js';

export class ApprovalRelay implements vscode.Disposable {
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly changeEmitter = new vscode.EventEmitter<ApprovalRequest[]>();
  readonly onChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** Requests a notification is currently showing for (avoid duplicates on reconnect). */
  private readonly notified = new Set<string>();

  constructor(private readonly bridge: BridgeConnection) {
    this.disposables.push(
      bridge.onFrame((frame) => {
        if (frame.type === 'auth_ok' || frame.type === 'pong') {
          const list = (frame as unknown as { pending?: ApprovalRequest[] }).pending ?? [];
          this.sync(list);
          return;
        }
        if (frame.type === 'approval_cancelled') {
          const id = (frame as { request_id?: string | null }).request_id;
          if (id) this.remove(id);
          else this.clear();
          return;
        }
        if (frame.type.endsWith('_request')) {
          const req = approvalFromPush(frame as Record<string, unknown>);
          if (req) this.add(req);
        }
      }),
    );
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  pendingCount(): number {
    return this.pending.size;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id);
  }

  private sync(list: ApprovalRequest[]): void {
    const ids = new Set(list.map((r) => r.request_id));
    for (const id of [...this.pending.keys()]) if (!ids.has(id)) this.pending.delete(id);
    for (const req of list) if (!this.pending.has(req.request_id)) this.add(req, false);
    this.changeEmitter.fire(this.list());
  }

  private add(req: ApprovalRequest, notify = true): void {
    this.pending.set(req.request_id, req);
    this.changeEmitter.fire(this.list());
    if (notify && readSettings().notifications && !this.notified.has(req.request_id)) {
      this.notified.add(req.request_id);
      void this.notify(req);
    }
  }

  private remove(id: string): void {
    if (this.pending.delete(id)) this.changeEmitter.fire(this.list());
  }

  private clear(): void {
    this.pending.clear();
    this.changeEmitter.fire(this.list());
  }

  /** Send the answer over the socket, falling back to REST when the socket is down. */
  async respond(id: string, response: ApprovalResponse): Promise<boolean> {
    const req = this.pending.get(id);
    if (!req) {
      void vscode.window.showInformationMessage('AgentVoice: that request was already answered (or timed out).');
      return false;
    }
    let sent = this.bridge.socket.respondApproval(id, response);
    if (!sent) {
      try {
        await this.bridge.http.respondApproval(id, response);
        sent = true;
      } catch (err) {
        void vscode.window.showErrorMessage(`AgentVoice: could not send the answer — ${errorMessage(err)}`);
        return false;
      }
    }
    this.remove(id);
    return true;
  }

  /** Full native UI for one request (also used by the "answer pending approval" command). */
  async prompt(req: ApprovalRequest): Promise<void> {
    switch (req.kind) {
      case 'permission': {
        const title = `${req.provider} wants to run: ${req.summary}`;
        const pick = await vscode.window.showWarningMessage(title, { modal: false }, 'Allow', 'Deny', 'Show input');
        if (pick === 'Show input') {
          const doc = await vscode.workspace.openTextDocument({
            language: 'json',
            content: JSON.stringify({ tool: req.tool_name, input: req.input }, null, 2),
          });
          await vscode.window.showTextDocument(doc, { preview: true });
          const again = await vscode.window.showWarningMessage(title, 'Allow', 'Deny');
          if (again) await this.respond(req.request_id, { kind: 'permission', decision: again === 'Allow' ? 'allow' : 'deny' });
          return;
        }
        if (pick) await this.respond(req.request_id, { kind: 'permission', decision: pick === 'Allow' ? 'allow' : 'deny' });
        return;
      }
      case 'user_input': {
        if (req.input_type === 'yesno') {
          const pick = await vscode.window.showInformationMessage(req.question, 'Yes', 'No');
          if (pick) await this.respond(req.request_id, { kind: 'user_input', answer: pick.toLowerCase() });
          return;
        }
        if (req.input_type === 'choice' && req.options?.length) {
          const pick = await vscode.window.showQuickPick(req.options, { title: req.question, placeHolder: 'Pick an answer' });
          if (pick) await this.respond(req.request_id, { kind: 'user_input', answer: pick });
          return;
        }
        const answer = await vscode.window.showInputBox({ title: 'The agent asks', prompt: req.question, ignoreFocusOut: true });
        if (answer !== undefined) await this.respond(req.request_id, { kind: 'user_input', answer });
        return;
      }
      case 'plan_approval': {
        const items: vscode.QuickPickItem[] = [
          { label: '$(check) Approve', description: 'Apply the plan', detail: 'approved' },
          { label: '$(edit) Modify', description: 'Approve with notes', detail: 'modified' },
          { label: '$(close) Reject', description: 'Do not apply', detail: 'rejected' },
          { label: '$(list-ordered) Show steps', detail: 'show' },
        ];
        const pick = await vscode.window.showQuickPick(items, {
          title: `Plan: ${req.title}`,
          placeHolder: req.estimated_impact ?? `${req.steps.length} steps`,
        });
        if (!pick) return;
        if (pick.detail === 'show') {
          const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: `# ${req.title}\n\n${req.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n${req.estimated_impact ? `Impact: ${req.estimated_impact}\n` : ''}`,
          });
          await vscode.window.showTextDocument(doc, { preview: true });
          return this.prompt(req);
        }
        const decision = pick.detail as 'approved' | 'modified' | 'rejected';
        let notes: string | undefined;
        if (decision !== 'approved') {
          notes = await vscode.window.showInputBox({ title: 'Notes for the agent', prompt: 'What should change?', ignoreFocusOut: true });
          if (notes === undefined) return;
        }
        await this.respond(req.request_id, { kind: 'plan_approval', decision, notes });
        return;
      }
      case 'secret_input': {
        const secret = await vscode.window.showInputBox({
          title: `${req.agent ?? 'The agent'} needs a password (${req.source})`,
          prompt: req.prompt,
          password: true,
          ignoreFocusOut: true,
        });
        // Cancelled → the prompt fails on the host (sudo reports a bad password).
        await this.respond(req.request_id, { kind: 'secret_input', secret: secret ?? null });
        return;
      }
    }
  }

  private async notify(req: ApprovalRequest): Promise<void> {
    if (req.kind === 'permission') {
      const pick = await vscode.window.showWarningMessage(
        `AgentVoice · ${req.provider} wants to run: ${req.summary}`,
        'Allow',
        'Deny',
        'Details…',
      );
      if (pick === 'Details…') return this.prompt(req);
      if (pick) await this.respond(req.request_id, { kind: 'permission', decision: pick === 'Allow' ? 'allow' : 'deny' });
      return;
    }
    const label =
      req.kind === 'user_input'
        ? `AgentVoice · question: ${req.question}`
        : req.kind === 'plan_approval'
          ? `AgentVoice · plan ready: ${req.title}`
          : `AgentVoice · ${req.agent ?? 'agent'} needs a ${req.source} password`;
    const pick = await vscode.window.showInformationMessage(label, 'Answer…');
    if (pick) await this.prompt(req);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.changeEmitter.dispose();
  }
}
