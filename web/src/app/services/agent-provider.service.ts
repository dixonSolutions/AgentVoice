import { Injectable, inject, signal } from '@angular/core';
import { BridgeService, type AuthFlowDescriptor, type AuthFlowId } from './bridge.service';

export interface ProviderSummary {
  id: string;
  displayName: string;
  installed: boolean;
  supportsModelSelection: boolean;
  authFlows: AuthFlowDescriptor[];
}

export interface ProvidersResponse {
  active: string;
  providers: ProviderSummary[];
}

export interface ProviderModel {
  id: string;
  displayName: string;
}

export interface ProviderModelsResponse {
  models: ProviderModel[];
  active_model: string;
  provider: string;
  supports_selection: boolean;
  total: number;
}

export interface AuthStartResponse {
  attemptId: string;
  flow: AuthFlowId;
  url: string | null;
  code: string | null;
  instructions: string;
  settled: boolean;
  result: { authenticated: boolean; email: string | null; detail?: string } | null;
}

export interface AuthPollResponse {
  attemptId: string;
  flow: AuthFlowId;
  url: string | null;
  code: string | null;
  settled: boolean;
  result: { authenticated: boolean; email: string | null; detail?: string } | null;
}

/**
 * Live agent-provider state — active model view/selection and phone-driven
 * login flows for whichever CLI (Cursor / Codex / Claude Code) is active.
 * See docs/24-agent-providers.md.
 */
@Injectable({ providedIn: 'root' })
export class AgentProviderService {
  private readonly bridge = inject(BridgeService);

  readonly providers = signal<ProviderSummary[]>([]);
  readonly activeProviderId = signal<string | null>(null);
  readonly models = signal<ProviderModel[]>([]);
  readonly activeModel = signal<string>('auto');
  readonly supportsModelSelection = signal<boolean>(true);
  readonly loadingModels = signal(false);
  readonly modelsError = signal<string | null>(null);

  get activeProvider(): ProviderSummary | null {
    return this.providers().find((p) => p.id === this.activeProviderId()) ?? null;
  }

  async refreshProviders(): Promise<void> {
    const res = await this.bridge.apiGet<ProvidersResponse>('/api/providers');
    this.providers.set(res.providers);
    this.activeProviderId.set(res.active);
  }

  /** Never throws — the model picker degrades to empty on failure (e.g. CLI needs sign-in). */
  async refreshModels(query?: string): Promise<void> {
    this.loadingModels.set(true);
    this.modelsError.set(null);
    try {
      const q = query ? `?query=${encodeURIComponent(query)}` : '';
      const res = await this.bridge.apiGet<ProviderModelsResponse>(`/api/providers/models${q}`);
      this.models.set(res.models);
      this.activeModel.set(res.active_model);
      this.supportsModelSelection.set(res.supports_selection);
    } catch (err) {
      this.modelsError.set(err instanceof Error ? err.message : String(err));
      this.models.set([]);
    } finally {
      this.loadingModels.set(false);
    }
  }

  async setModel(modelId: string, scope: 'global' | 'session' = 'global'): Promise<void> {
    await this.bridge.apiPost('/api/providers/model', { model_id: modelId, scope });
    this.activeModel.set(modelId);
  }

  async getProviderStatus(
    providerId: string,
  ): Promise<{ authenticated: boolean; email: string | null }> {
    return this.bridge.apiGet(`/api/providers/${providerId}/status`);
  }

  async startAuth(providerId: string, flow: AuthFlowId, pasted?: string): Promise<AuthStartResponse> {
    return this.bridge.apiPost<AuthStartResponse>(`/api/providers/${providerId}/auth/start`, {
      flow,
      pasted,
    });
  }

  async pollAuth(providerId: string, attemptId: string): Promise<AuthPollResponse> {
    return this.bridge.apiGet<AuthPollResponse>(`/api/providers/${providerId}/auth/poll/${attemptId}`);
  }

  async cancelAuth(providerId: string, attemptId: string): Promise<void> {
    await this.bridge.apiPost(`/api/providers/${providerId}/auth/cancel/${attemptId}`, {});
  }
}
