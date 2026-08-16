import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from '@openng/optimus-ui/button';
import { InputText } from '@openng/optimus-ui/inputtext';
import { Textarea } from '@openng/optimus-ui/textarea';

import {
  BridgeService,
  type ApprovalRequest,
  type PlanApprovalRequest,
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
 * Two modes:
 *   - user_input  : question card with Yes/No buttons, choice chips, or text field
 *   - plan_approval: plan review card with step list + approve / reject / modify
 */
@Component({
  selector: 'cv-approval-panel',
  standalone: true,
  imports: [FormsModule, Button, InputText, Textarea],
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

  /** Free-text answer typed by the user. */
  protected freeText = '';

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

  protected readonly showModifyField = signal(false);

  protected toggleModify(): void {
    this.showModifyField.update((v) => !v);
  }

  private _reset(): void {
    this.freeText = '';
    this.modifyNotes = '';
    this.showModifyField.set(false);
  }
}
