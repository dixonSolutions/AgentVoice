import { Injectable, computed, inject, signal } from '@angular/core';
import { FALLBACK_AGENT_NAME } from '../branding';
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

/** One (effort, fast) pair a Cursor-style model id encodes — see ModelEntry.variants on the bridge. */
export interface ProviderModelVariant {
  effort: string | null;
  fast: boolean;
  id: string;
}

/**
 * A model as the active CLI reports it. `efforts` and `fast` are per model —
 * the picker shows exactly those knobs and nothing else.
 */
export interface ProviderModel {
  id: string;
  displayName: string;
  description?: string;
  vendor?: string;
  efforts: string[];
  defaultEffort: string | null;
  fast: boolean;
  variants?: ProviderModelVariant[];
}

export interface ModelSelection {
  model: string;
  effort: string | null;
  fast: boolean;
}

export interface ProviderModelsResponse {
  models: ProviderModel[];
  active_model: string;
  active: ModelSelection;
  active_label: string;
  cached_at: string | null;
  provider: string;
  supports_selection: boolean;
  total: number;
}

interface SetModelResponse {
  ok: boolean;
  active: ModelSelection;
  label: string;
  displayName: string;
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

/** Effort ids are the CLI's own; prettify the common ones, pass others through. */
export function effortLabel(effort: string | null): string {
  switch (effort) {
    case null:
      return 'Default';
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case 'max':
      return 'Max';
    case 'ultra':
      return 'Ultra';
    default:
      return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

/**
 * Live agent-provider state — active model view/selection, the agent's display
 * name for the UI, and phone-driven login flows for whichever CLI
 * (Cursor / Codex / Claude Code / Codewhale) is active. See docs/24-agent-providers.md.
 */
@Injectable({ providedIn: 'root' })
export class AgentProviderService {
  private readonly bridge = inject(BridgeService);

  readonly providers = signal<ProviderSummary[]>([]);
  readonly activeProviderId = signal<string | null>(null);
  readonly models = signal<ProviderModel[]>([]);
  /** Model + effort + fast the bridge is running with (admin/default session). */
  readonly activeSelection = signal<ModelSelection>({ model: 'auto', effort: null, fast: false });
  /** "Opus (1M context) · High · Fast" — from the bridge, so voice and UI agree. */
  readonly activeLabel = signal<string>('Auto');
  /** @deprecated read activeSelection().model */
  readonly activeModel = computed(() => this.activeSelection().model);
  readonly supportsModelSelection = signal<boolean>(true);
  readonly loadingModels = signal(false);
  readonly modelsError = signal<string | null>(null);
  /** When the bridge last probed the CLI — null when the list was just fetched live. */
  readonly modelsCachedAt = signal<string | null>(null);

  get activeProvider(): ProviderSummary | null {
    return this.providers().find((p) => p.id === this.activeProviderId()) ?? null;
  }

  /**
   * Display name of the coding agent currently in use.
   *
   * The single source for every user-facing mention of the agent. Nothing in
   * the UI may hardcode "Cursor": the name has to follow settings.agentClient
   * or a Claude Code user reads Cursor's name on every log line.
   */
  readonly activeProviderName = computed(() => {
    const id = this.activeProviderId();
    const match = this.providers().find((p) => p.id === id);
    return match?.displayName ?? FALLBACK_AGENT_NAME;
  });

  modelById(id: string | null): ProviderModel | null {
    if (!id) return null;
    const models = this.models();
    return (
      models.find((m) => m.id === id) ??
      models.find((m) => m.variants?.some((v) => v.id === id)) ??
      null
    );
  }

  async refreshProviders(): Promise<void> {
    const res = await this.bridge.apiGet<ProvidersResponse>('/api/providers');
    this.providers.set(res.providers);
    this.activeProviderId.set(res.active);
  }

  /**
   * Never throws — the model picker degrades to an inline error on failure
   * (e.g. CLI needs sign-in). `force` bypasses the bridge cache and re-probes
   * the CLI.
   */
  async refreshModels(opts: { query?: string; force?: boolean } = {}): Promise<void> {
    this.loadingModels.set(true);
    this.modelsError.set(null);
    try {
      const params = new URLSearchParams();
      if (opts.query) params.set('query', opts.query);
      if (opts.force) params.set('refresh', '1');
      const qs = params.toString();
      const res = await this.bridge.apiGet<ProviderModelsResponse>(`/api/providers/models${qs ? `?${qs}` : ''}`);
      this.models.set(res.models);
      this.activeSelection.set(res.active ?? { model: res.active_model, effort: null, fast: false });
      this.activeLabel.set(res.active_label ?? res.active_model);
      this.supportsModelSelection.set(res.supports_selection);
      this.modelsCachedAt.set(res.cached_at);
    } catch (err) {
      this.modelsError.set(err instanceof Error ? err.message : String(err));
      this.models.set([]);
    } finally {
      this.loadingModels.set(false);
    }
  }

  /**
   * Apply a selection. The bridge snaps effort/fast to what the CLI offers for
   * the model and returns the result — adopt that, not what was asked for, so
   * the UI never claims a level the CLI will not run.
   */
  async setSelection(selection: ModelSelection, scope: 'global' | 'session' = 'global'): Promise<SetModelResponse> {
    const res = await this.bridge.apiPost<SetModelResponse>('/api/providers/model', {
      model_id: selection.model,
      effort: selection.effort,
      fast: selection.fast,
      scope,
    });
    this.activeSelection.set(res.active);
    this.activeLabel.set(res.label);
    return res;
  }

  /** @deprecated use setSelection — kept for callers that only know a model id. */
  async setModel(modelId: string, scope: 'global' | 'session' = 'global'): Promise<void> {
    const current = this.activeSelection();
    await this.setSelection({ model: modelId, effort: current.effort, fast: current.fast }, scope);
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
