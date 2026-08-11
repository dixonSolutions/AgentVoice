/**
 * Admin service — HTTP calls for the developer config centre.
 *
 * Wraps all /api/admin/* and /api/admin/projects/* endpoints.
 * Delegates credential/base-URL resolution to BridgeService.
 */

import { inject, Injectable } from '@angular/core';
import { BridgeService } from './bridge.service';
import type {
  WorkflowSettings,
  HostingSettings,
  ServeSettings,
  ServeStatus,
  ServeEvent,
  ServeActionId,
  ServeServiceLogs,
  JobSettings,
  NarratorSettings,
  KeysStatus,
  KeysTestResult,
  AdminProject,
  DbStats,
  AuditEntry,
  AgentClientSettings,
  AgentClientId,
  PollyVoiceInfo,
  TranscribeModelInfo,
  HostingProviderId,
  HostingProvidersResponse,
  HostingSetupRunStatus,
  HostingDoctorResult,
} from '../models/admin-settings';

@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly bridge = inject(BridgeService);

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.bridge.apiGet<T>(path);
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    return this.bridge.apiPatch<T>(path, body);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.bridge.apiPost<T>(path, body ?? {});
  }

  private async delete<T>(path: string): Promise<T> {
    return this.bridge.apiDelete<T>(path);
  }

  // ── Workflow ─────────────────────────────────────────────────────────────

  getWorkflow(): Promise<{ workflow: WorkflowSettings }> {
    return this.get('/api/admin/workflow');
  }

  patchWorkflow(patch: Partial<WorkflowSettings>): Promise<{ ok: boolean; workflow: WorkflowSettings }> {
    return this.patch('/api/admin/workflow', patch);
  }

  // ── Hosting ──────────────────────────────────────────────────────────────

  getHosting(): Promise<HostingSettings> {
    return this.get('/api/admin/hosting');
  }

  patchHosting(patch: Partial<HostingSettings>): Promise<{ ok: boolean } & HostingSettings> {
    return this.patch('/api/admin/hosting', patch);
  }

  // ── Pluggable hosting providers ───────────────────────────────────────────

  getHostingProviders(): Promise<HostingProvidersResponse> {
    return this.get('/api/admin/hosting-providers');
  }

  setActiveHostingProvider(
    provider: HostingProviderId | null,
  ): Promise<{ ok: boolean; active: HostingProviderId }> {
    return this.patch('/api/admin/hosting-providers/active', { provider });
  }

  startHostingSetup(
    provider: HostingProviderId,
    opts: { hostname?: string; loginServer?: string } = {},
  ): Promise<{ runId: string; provider: HostingProviderId }> {
    return this.post('/api/admin/hosting-providers/setup', { provider, ...opts });
  }

  getHostingSetupRun(runId: string): Promise<HostingSetupRunStatus> {
    return this.get(`/api/admin/hosting-providers/setup/${encodeURIComponent(runId)}`);
  }

  getHostingDoctor(provider?: HostingProviderId): Promise<HostingDoctorResult | { results: HostingDoctorResult[] }> {
    const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return this.get(`/api/admin/hosting-providers/doctor${q}`);
  }

  // ── Serve ────────────────────────────────────────────────────────────────

  getServe(): Promise<{ serve: ServeSettings; status: ServeStatus }> {
    return this.get('/api/admin/serve');
  }

  patchServe(
    patch: Partial<ServeSettings>,
  ): Promise<{ ok: boolean; serve: ServeSettings; status: ServeStatus }> {
    return this.patch('/api/admin/serve', patch);
  }

  runServe(): Promise<{ ok: boolean; started: boolean; runId: string }> {
    return this.post('/api/admin/serve/run');
  }

  serveAction(
    action: ServeActionId,
  ): Promise<{ ok: boolean; outcome: string; detail: string; runId: string; status: ServeStatus }> {
    return this.post('/api/admin/serve/action', { action });
  }

  getServeEvents(limit = 50): Promise<{ entries: ServeEvent[] }> {
    return this.get(`/api/admin/serve/events?limit=${limit}`);
  }

  getServeLogs(lines = 80): Promise<ServeServiceLogs> {
    return this.get(`/api/admin/serve/logs?lines=${lines}`);
  }

  installHosting(): Promise<{ ok: boolean; detail: string }> {
    return this.post('/api/admin/serve/install');
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  getJobs(): Promise<JobSettings> {
    return this.get('/api/admin/jobs');
  }

  patchJobs(patch: Partial<JobSettings>): Promise<{ ok: boolean } & JobSettings> {
    return this.patch('/api/admin/jobs', patch);
  }

  // ── Narrator ─────────────────────────────────────────────────────────────

  getNarrator(): Promise<NarratorSettings> {
    return this.get('/api/admin/narrator');
  }

  patchNarrator(patch: Partial<NarratorSettings>): Promise<{ ok: boolean } & NarratorSettings> {
    return this.patch('/api/admin/narrator', patch);
  }

  // ── AWS Keys ─────────────────────────────────────────────────────────────

  getKeys(): Promise<KeysStatus> {
    return this.get('/api/admin/keys');
  }

  patchKeys(updates: Record<string, string>): Promise<{ ok: boolean } & KeysStatus> {
    return this.patch('/api/admin/keys', updates);
  }

  testKeys(): Promise<KeysTestResult> {
    return this.post('/api/admin/keys/test');
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  getAdminProjects(): Promise<{ projects: AdminProject[] }> {
    return this.get('/api/admin/projects');
  }

  createProject(project: {
    name: string;
    path: string;
    description?: string;
    aliases?: string[];
    enabled?: boolean;
  }): Promise<{ ok: boolean; project: AdminProject }> {
    return this.post('/api/admin/projects', project);
  }

  updateProject(
    name: string,
    patch: { path?: string; description?: string | null; aliases?: string[]; enabled?: boolean },
  ): Promise<{ ok: boolean; project: AdminProject }> {
    return this.patch(`/api/admin/projects/${encodeURIComponent(name)}`, patch);
  }

  deleteProject(name: string): Promise<{ ok: boolean; name: string }> {
    return this.delete(`/api/admin/projects/${encodeURIComponent(name)}`);
  }

  pingProject(name: string): Promise<{ name: string; path: string; exists: boolean }> {
    return this.post(`/api/admin/projects/${encodeURIComponent(name)}/ping`);
  }

  // ── Agent Client ─────────────────────────────────────────────────────────

  getAgentClient(): Promise<AgentClientSettings> {
    return this.get('/api/admin/agent-client');
  }

  setAgentClient(client: AgentClientId): Promise<{ ok: boolean } & AgentClientSettings> {
    return this.patch('/api/admin/agent-client', { client });
  }

  // ── Database ─────────────────────────────────────────────────────────────

  getDbStats(): Promise<DbStats> {
    return this.get('/api/admin/db/stats');
  }

  getAuditLog(limit = 50): Promise<{ entries: AuditEntry[] }> {
    return this.get(`/api/admin/db/audit?limit=${limit}`);
  }

  clearSessions(): Promise<{ ok: boolean; cleared: number }> {
    return this.delete('/api/admin/sessions');
  }

  // ── Speech / Polly ───────────────────────────────────────────────────────

  getPollyVoices(
    engine?: 'standard' | 'neural' | 'generative',
  ): Promise<{ engine: string; voices: PollyVoiceInfo[] }> {
    const q = engine ? `?engine=${encodeURIComponent(engine)}` : '';
    return this.get(`/api/intelligence/polly-voices${q}`);
  }

  getTranscribeModels(): Promise<{ models: TranscribeModelInfo[]; note: string }> {
    return this.get('/api/intelligence/transcribe-models');
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async pingHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.bridge.apiGet('/healthz');
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
