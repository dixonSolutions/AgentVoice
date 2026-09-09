/**
 * BridgeHttp — the REST surface every frontend needs, over an injectable
 * `fetch` so it runs in a browser, an extension host (Node 20+), or a webview.
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  DeskState,
  DiffResult,
  HealthInfo,
  JobHistoryEntry,
  ModelsView,
  PermissionModesView,
  ProjectSummary,
  SessionsResponse,
  TurnAccepted,
  WorkspaceProjectView,
} from './protocol.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BridgeHttpOptions {
  /** Origin of the bridge, e.g. http://127.0.0.1:5089 — or '' for same-origin. */
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class BridgeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

export class BridgeHttp {
  private readonly fetchImpl: FetchLike;

  constructor(private opts: BridgeHttpOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  get token(): string {
    return this.opts.token;
  }

  configure(patch: Partial<BridgeHttpOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /** WebSocket URL for `/ws/events` derived from the base URL. */
  eventsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws/events`;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (init.body !== undefined && init.body !== null && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        detail = body.message || body.error || detail;
      } catch {
        // non-JSON error body
      }
      throw new BridgeHttpError(res.status, detail, path);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  // ── Unauthenticated ─────────────────────────────────────────────────────

  async health(): Promise<HealthInfo> {
    const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
    if (!res.ok) throw new BridgeHttpError(res.status, `Bridge unhealthy (${res.status})`, '/healthz');
    return (await res.json()) as HealthInfo;
  }

  // ── State ───────────────────────────────────────────────────────────────

  agentState(): Promise<DeskState> {
    return this.get<DeskState>('/api/agent/state');
  }

  async projects(): Promise<ProjectSummary[]> {
    return (await this.get<{ projects: ProjectSummary[] }>('/api/projects')).projects;
  }

  activeProject(): Promise<{ activeProject: string | null; activeModel: string; activeEffort: string | null; activeFast: boolean }> {
    return this.get('/api/active-project');
  }

  setActiveProject(project: string): Promise<{ activeProject: string; description: string | null }> {
    return this.post('/api/active-project', { project });
  }

  workspaceProject(path: string): Promise<{ project: WorkspaceProjectView | null; activeProject: string | null }> {
    return this.get(`/api/workspace/project?path=${encodeURIComponent(path)}`);
  }

  registerWorkspace(body: { path: string; name?: string; description?: string; activate?: boolean }): Promise<{
    ok: true;
    created: boolean;
    project: WorkspaceProjectView;
    activeProject: string | null;
  }> {
    return this.post('/api/workspace/project', body);
  }

  // ── Models / permissions ────────────────────────────────────────────────

  models(refresh = false): Promise<ModelsView> {
    return this.get<ModelsView>(`/api/providers/models${refresh ? '?refresh=1' : ''}`);
  }

  setModel(body: { model_id: string; effort?: string | null; fast?: boolean; scope?: 'global' | 'session' }): Promise<unknown> {
    return this.post('/api/providers/model', body);
  }

  permissionModes(): Promise<PermissionModesView> {
    return this.get<PermissionModesView>('/api/providers/permission-modes');
  }

  setPermissionMode(mode: string): Promise<PermissionModesView> {
    return this.post('/api/providers/permission-mode', { mode });
  }

  // ── Approvals ───────────────────────────────────────────────────────────

  async pendingApprovals(): Promise<ApprovalRequest[]> {
    return (await this.get<{ pending: ApprovalRequest[] }>('/api/pending-approvals')).pending;
  }

  respondApproval(requestId: string, response: ApprovalResponse): Promise<{ ok: true; request_id: string }> {
    return this.post(`/api/approvals/${encodeURIComponent(requestId)}/respond`, response);
  }

  // ── Turns / tools ───────────────────────────────────────────────────────

  submitTurn(text: string, opts: { is_interrupt?: boolean; source?: string } = {}): Promise<TurnAccepted> {
    return this.post('/api/turns', { text, ...opts });
  }

  /** Any `agent_*` MCP tool through the bridge's allowlist + audit log. */
  async tool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const out = await this.post<{ ok: true; tool: string; result: T }>(`/api/tools/${encodeURIComponent(name)}`, args);
    return out.result;
  }

  diff(fullPatch = false, project?: string): Promise<DiffResult> {
    return this.tool<DiffResult>('agent_diff', { full_patch: fullPatch, ...(project ? { project } : {}) });
  }

  jobsHistory(project?: string, limit = 20): Promise<{ jobs: JobHistoryEntry[] }> {
    const q = new URLSearchParams({ ...(project ? { project } : {}), limit: String(limit) });
    return this.get(`/api/jobs?${q}`);
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  sessions(project: string): Promise<SessionsResponse> {
    return this.get<SessionsResponse>(`/api/agent-sessions?${new URLSearchParams({ project })}`);
  }

  selectSession(project: string, sessionId: string): Promise<{ project: string; active_session_id: string; message: string }> {
    return this.post('/api/agent-sessions/select', { project, session_id: sessionId });
  }

  newSession(project: string): Promise<{ project: string; active_session_id: string | null; message: string }> {
    return this.post('/api/agent-sessions/new', { project });
  }

  /** Register the bridge's MCP server with the active CLI (idempotent; the PWA does this before voice). */
  async prepare(project: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/voice-session/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ project }),
    });
    if (!res.ok) throw new BridgeHttpError(res.status, `prepare failed (${res.status})`, '/api/voice-session/prepare');
    // Drain the SSE stream; the terminal `complete` event carries ok/message.
    const text = await res.text();
    const complete = text.split('\n\n').find((block) => block.includes('event: complete'));
    if (complete) {
      const data = complete.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (data) {
        const payload = JSON.parse(data) as { ok?: boolean; message?: string };
        if (payload.ok === false) throw new Error(payload.message ?? 'MCP registration failed');
      }
    }
  }

  // ── Speech ──────────────────────────────────────────────────────────────

  /** Server-side TTS audio for one line, if a speech output provider is configured. */
  async tts(text: string, language?: string): Promise<{ audio: ArrayBuffer; contentType: string; provider: string | null }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/intelligence/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(language ? { language } : {}) }),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        detail = ((await res.json()) as { error?: string }).error ?? detail;
      } catch {
        // ignore
      }
      throw new BridgeHttpError(res.status, detail, '/api/intelligence/tts');
    }
    return {
      audio: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      provider: res.headers.get('x-speech-provider'),
    };
  }
}
