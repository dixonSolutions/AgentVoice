import { Component, computed, inject, signal, type OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from '@openng/optimus-ui/button';
import { InputText } from '@openng/optimus-ui/inputtext';

import { BridgeService, type AuthFlowDescriptor } from '../../services/bridge.service';
import { AgentProviderService, type AuthStartResponse } from '../../services/agent-provider.service';
import { ToastService } from '../../services/toast.service';

type CardStage = 'choose-flow' | 'paste' | 'waiting' | 'success' | 'error';

const POLL_INTERVAL_MS = 3000;

/**
 * AuthCardComponent — shown when the active agent CLI needs the user to sign
 * in (see providers/agents/authNotify.ts). Follows whatever flows the active
 * provider declares (browser-url / device-code / token-paste / api-key) —
 * never hardcodes provider-specific knowledge.
 */
@Component({
  selector: 'cv-auth-card',
  standalone: true,
  imports: [FormsModule, Button, InputText],
  templateUrl: './auth-card.component.html',
})
export class AuthCardComponent implements OnDestroy {
  private readonly bridge = inject(BridgeService);
  private readonly agentProviders = inject(AgentProviderService);
  private readonly toast = inject(ToastService);

  protected readonly pending = computed(() => this.bridge.pendingAuthRequired());

  protected readonly stage = signal<CardStage>('choose-flow');
  protected readonly selectedFlow = signal<AuthFlowDescriptor | null>(null);
  protected readonly attempt = signal<AuthStartResponse | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly successEmail = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected pasteValue = '';

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy(): void {
    this._stopPolling();
  }

  protected chooseFlow(flow: AuthFlowDescriptor): void {
    this.selectedFlow.set(flow);
    this.errorMessage.set(null);
    if (flow.id === 'token-paste' || flow.id === 'api-key') {
      this.pasteValue = '';
      this.stage.set('paste');
      return;
    }
    void this._start(flow);
  }

  protected submitPaste(): void {
    const flow = this.selectedFlow();
    const value = this.pasteValue.trim();
    if (!flow || !value) return;
    void this._start(flow, value);
  }

  protected backToChoices(): void {
    this._stopPolling();
    this.stage.set('choose-flow');
    this.selectedFlow.set(null);
    this.attempt.set(null);
    this.errorMessage.set(null);
  }

  protected openUrl(): void {
    const url = this.attempt()?.url;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  protected async cancel(): Promise<void> {
    const req = this.pending();
    const attemptId = this.attempt()?.attemptId;
    this._stopPolling();
    if (req && attemptId) {
      try {
        await this.agentProviders.cancelAuth(req.provider, attemptId);
      } catch {
        // best-effort — the card is closing regardless
      }
    }
    this._reset();
  }

  protected dismiss(): void {
    this._stopPolling();
    this._reset();
  }

  private async _start(flow: AuthFlowDescriptor, pasted?: string): Promise<void> {
    const req = this.pending();
    if (!req) return;
    this.starting.set(true);
    this.errorMessage.set(null);
    try {
      const start = await this.agentProviders.startAuth(req.provider, flow.id, pasted);
      this.attempt.set(start);
      if (start.settled) {
        this._handleResult(start.result);
      } else {
        this.stage.set('waiting');
        this._startPolling(req.provider, start.attemptId);
      }
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
      this.stage.set('error');
    } finally {
      this.starting.set(false);
    }
  }

  private _startPolling(provider: string, attemptId: string): void {
    this._stopPolling();
    this.pollTimer = setInterval(() => {
      void this.agentProviders
        .pollAuth(provider, attemptId)
        .then((res) => {
          this.attempt.set({ ...this.attempt()!, url: res.url, code: res.code });
          if (res.settled) {
            this._stopPolling();
            this._handleResult(res.result);
          }
        })
        .catch(() => {
          this._stopPolling();
          this.errorMessage.set('Lost track of the login attempt — try again.');
          this.stage.set('error');
        });
    }, POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private _handleResult(result: { authenticated: boolean; email: string | null; detail?: string } | null): void {
    if (result?.authenticated) {
      this.successEmail.set(result.email);
      this.stage.set('success');
      this.toast.info('Signed in', this.pending()?.displayName ?? 'Agent');
      setTimeout(() => this._reset(), 2200);
    } else {
      this.errorMessage.set(result?.detail || 'Sign-in did not complete — try again.');
      this.stage.set('error');
    }
  }

  private _reset(): void {
    this.bridge.pendingAuthRequired.set(null);
    this.stage.set('choose-flow');
    this.selectedFlow.set(null);
    this.attempt.set(null);
    this.errorMessage.set(null);
    this.successEmail.set(null);
    this.pasteValue = '';
  }
}
