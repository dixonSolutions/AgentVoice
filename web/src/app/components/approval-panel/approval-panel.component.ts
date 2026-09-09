import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from '@openng/optimus-ui/button';
import { InputText } from '@openng/optimus-ui/inputtext';
import { Password } from '@openng/optimus-ui/password';
import { Textarea } from '@openng/optimus-ui/textarea';

import {
  BridgeService,
  type PermissionRequest,
  type PlanApprovalRequest,
  type SecretInputRequest,
  type UserInputRequest,
} from '../../services/bridge.service';
import { AgentProviderService } from '../../services/agent-provider.service';

/**
 * ApprovalPanelComponent — presents agent-initiated requests to the user.
 *
 * Shown when an MCP tool call (`request_user_input` or `submit_plan_for_approval`)
 * is blocking on the user's input. The panel appears over the voice tab and
 * dismisses once the user answers.
 *
 * Four cards:
 *   - user_input   : question card with Yes/No buttons, choice chips, or text field
 *   - plan_approval: plan review card with step list + approve / reject / modify
 *   - permission   : the CLI's own permission prompt (Claude Code) — allow / deny
 *   - secret_input : a sudo / git / ssh password prompt from the agent's shell
 */
@Component({
  selector: 'cv-approval-panel',
  standalone: true,
  imports: [FormsModule, Button, InputText, Password, Textarea],
  templateUrl: './approval-panel.component.html',
})
export class ApprovalPanelComponent {
  protected readonly bridge = inject(BridgeService);
  private readonly agentProviders = inject(AgentProviderService);

  /** Who is asking — the active coding agent, never a hardcoded name. */
  protected readonly agentName = this.agentProviders.activeProviderName;

  protected readonly pending = computed(() => this.bridge.pendingApproval());

  protected readonly isUserInput = computed(
    (): this is ApprovalPanelComponent & { _req: UserInputRequest } =>
      this.pending()?.kind === 'user_input',
  );

  protected readonly isPlanApproval = computed(
    (): this is ApprovalPanelComponent & { _req: PlanApprovalRequest } =>
      this.pending()?.kind === 'plan_approval',
  );

  protected readonly asUserInput = computed(
    () => (this.pending()?.kind === 'user_input' ? (this.pending() as UserInputRequest) : null),
  );

  protected readonly asPlanApproval = computed(
    () =>
      this.pending()?.kind === 'plan_approval'
        ? (this.pending() as PlanApprovalRequest)
        : null,
  );

  protected readonly asPermission = computed(
    () => (this.pending()?.kind === 'permission' ? (this.pending() as PermissionRequest) : null),
  );

  protected readonly asSecretInput = computed(
    () => (this.pending()?.kind === 'secret_input' ? (this.pending() as SecretInputRequest) : null),
  );

  /** Free-text answer typed by the user. */
  protected freeText = '';

  /** Password typed for a secret_input card — cleared the moment it is sent. */
  protected secret = '';

  /** Notes for modified plan. */
  protected modifyNotes = '';

  // ── User Input handlers ────────────────────────────────────────────────

  protected answerYes(): void {
    const req = this.asUserInput();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'user_input', answer: 'yes' });
    this._reset();
  }

  protected answerNo(): void {
    const req = this.asUserInput();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'user_input', answer: 'no' });
    this._reset();
  }

  protected answerChoice(option: string): void {
    const req = this.asUserInput();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'user_input', answer: option });
    this._reset();
  }

  protected submitFreeText(): void {
    const req = this.asUserInput();
    const text = this.freeText.trim();
    if (!req || !text) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'user_input', answer: text });
    this._reset();
  }

  // ── Plan Approval handlers ─────────────────────────────────────────────

  protected approvePlan(): void {
    const req = this.asPlanApproval();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'plan_approval', decision: 'approved' });
    this._reset();
  }

  protected rejectPlan(): void {
    const req = this.asPlanApproval();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, {
      kind: 'plan_approval',
      decision: 'rejected',
      notes: this.modifyNotes.trim() || undefined,
    });
    this._reset();
  }

  protected modifyPlan(): void {
    const req = this.asPlanApproval();
    const notes = this.modifyNotes.trim();
    if (!req || !notes) return;
    this.bridge.sendApprovalResponse(req.request_id, {
      kind: 'plan_approval',
      decision: 'modified',
      notes,
    });
    this._reset();
  }

  // ── Permission handlers ────────────────────────────────────────────────

  protected allowPermission(): void {
    const req = this.asPermission();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'permission', decision: 'allow' });
    this._reset();
  }

  protected denyPermission(): void {
    const req = this.asPermission();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'permission', decision: 'deny' });
    this._reset();
  }

  // ── Secret input handlers ─────────────────────────────────────────────

  protected submitSecret(): void {
    const req = this.asSecretInput();
    const secret = this.secret;
    if (!req || !secret) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'secret_input', secret });
    this._reset();
  }

  protected cancelSecret(): void {
    const req = this.asSecretInput();
    if (!req) return;
    this.bridge.sendApprovalResponse(req.request_id, { kind: 'secret_input', secret: null });
    this._reset();
  }

  protected secretTitle(req: SecretInputRequest): string {
    switch (req.source) {
      case 'sudo':
        return 'sudo needs your password';
      case 'git':
        return 'Git needs a credential';
      case 'ssh':
        return 'SSH needs a passphrase';
      default:
        return 'Password needed';
    }
  }

  protected readonly showModifyField = signal(false);

  protected toggleModify(): void {
    this.showModifyField.update((v) => !v);
  }

  // ── Dismiss ─────────────────────────────────────────────────────────────

  /**
   * Close the popup without answering it. There is no neutral "no answer" on
   * the wire — the blocked MCP tool call needs *some* response to unblock —
   * so a dismiss is reported as the most conservative outcome: "no" for a
   * yes/no question, the same answer as typing nothing for free text/choice,
   * and "rejected" for a plan. This mirrors tapping the safe button rather
   * than leaving the agent (and the user) stuck on an unanswerable card.
   */
  protected dismiss(): void {
    if (this.asPermission()) {
      this.denyPermission();
      return;
    }
    if (this.asSecretInput()) {
      this.cancelSecret();
      return;
    }
    const userInput = this.asUserInput();
    if (userInput) {
      this.bridge.sendApprovalResponse(userInput.request_id, { kind: 'user_input', answer: 'no' });
      this._reset();
      return;
    }
    const plan = this.asPlanApproval();
    if (plan) {
      this.bridge.sendApprovalResponse(plan.request_id, {
        kind: 'plan_approval',
        decision: 'rejected',
        notes: 'Dismissed without review',
      });
      this._reset();
    }
  }

  private _reset(): void {
    this.freeText = '';
    this.secret = '';
    this.modifyNotes = '';
    this.showModifyField.set(false);
  }
}
