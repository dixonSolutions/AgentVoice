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
  HostingProviderId,
  HostingProvidersResponse,
  HostingSetupRunStatus,
  HostingDoctorResult,
} from '../models/admin-settings';
import type {
  SpeechView,
  SpeechInputPatch,
  SpeechOutputPatch,
  SpeechInputProviderId,
  SpeechOutputProviderId,
  SpeechInputTestResult,
  SpeechVoiceCatalog,
  SpeechServerStatus,
  SpeechSetupRunStatus,
} from '../models/speech';

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

  /**
   * Follow journalctl -f over SSE. Resolves when the stream ends or is aborted.
   */
  async streamServeLogs(
    onEvent: (event: { type: 'meta' | 'log' | 'error' | 'end'; line?: string; detail?: string; unit?: string }) => void,
    signal: AbortSignal,
    lines = 120,
  ): Promise<void> {
    const res = await fetch(`/api/admin/serve/logs/stream?lines=${lines}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.bridge.appToken}`,
        Accept: 'text/event-stream',
      },
      signal,
    });

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    if (!res.body) {
      throw new Error('Journal stream missing response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processBlock = (block: string): void => {
      const linesInBlock = block.split('\n');
      let eventName = 'message';
      let dataLine = '';
      for (const line of linesInBlock) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) return;
      const payload = JSON.parse(dataLine) as { line?: string; detail?: string; unit?: string; code?: number };
      if (eventName === 'log' && payload.line) {
        onEvent({ type: 'log', line: payload.line });
      } else if (eventName === 'meta') {
        onEvent({ type: 'meta', unit: payload.unit });
      } else if (eventName === 'error') {
        onEvent({ type: 'error', detail: payload.detail });
      } else if (eventName === 'end') {
        onEvent({ type: 'end' });
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) processBlock(block);
      }
      if (buffer.trim()) processBlock(buffer);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
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

  // ── Speech providers (both directions) ───────────────────────────────────

  getSpeech(): Promise<SpeechView> {
    return this.get('/api/speech');
  }

  patchSpeechInput(patch: SpeechInputPatch): Promise<{ ok: boolean } & SpeechView> {
    return this.patch('/api/speech/stt', patch);
  }

  patchSpeechOutput(patch: SpeechOutputPatch): Promise<{ ok: boolean } & SpeechView> {
    return this.patch('/api/speech/tts', patch);
  }

  /** Values go straight into .env and are never read back — status only. */
  patchSpeechKeys(updates: Record<string, string>): Promise<{ ok: boolean } & SpeechView> {
    return this.patch('/api/speech/keys', updates);
  }

  testSpeechInput(
    provider: SpeechInputProviderId,
    model?: string,
  ): Promise<SpeechInputTestResult> {
    return this.post(`/api/speech/stt/${encodeURIComponent(provider)}/test`, model ? { model } : {});
  }

  getSpeechVoices(provider: SpeechOutputProviderId, model?: string): Promise<SpeechVoiceCatalog> {
    const q = model ? `?model=${encodeURIComponent(model)}` : '';
    return this.get(`/api/speech/tts/${encodeURIComponent(provider)}/voices${q}`);
  }

  /**
   * Synthesize a preview line and hand back a playable object URL. Returns the
   * audio itself rather than JSON, so this bypasses the JSON helpers.
   */
  async previewSpeechOutput(
    provider: SpeechOutputProviderId,
    opts: { model?: string; voice?: string; text?: string } = {},
  ): Promise<{ url: string; revoke: () => void }> {
    const res = await fetch(
      `${this.bridge.bridgeBase}/api/speech/tts/${encodeURIComponent(provider)}/test`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.bridge.appToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(opts),
      },
    );

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // non-JSON error body — keep the status line
      }
      throw new Error(detail);
    }

    const url = URL.createObjectURL(await res.blob());
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  // ── Self-hosted speech server ────────────────────────────────────────────

  getSpeechServerStatus(): Promise<SpeechServerStatus> {
    return this.get('/api/speech/server/status');
  }

  startSpeechServerSetup(): Promise<{ runId: string }> {
    return this.post('/api/speech/server/setup');
  }

  getSpeechServerSetupRun(runId: string): Promise<SpeechSetupRunStatus> {
    return this.get(`/api/speech/server/setup/${encodeURIComponent(runId)}`);
  }

  stopSpeechServer(
    remove = false,
  ): Promise<{ ok: boolean; detail: string; status: SpeechServerStatus }> {
    return this.post('/api/speech/server/stop', { remove });
  }

  getSpeechServerLogs(lines = 120): Promise<{ lines: number; text: string }> {
    return this.get(`/api/speech/server/logs?lines=${lines}`);
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
