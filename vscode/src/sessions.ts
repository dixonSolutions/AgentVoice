/**
 * Agents, jobs & sessions view: the conversational agent, running worker
 * jobs, recent job history, and the CLI threads the active project can resume.
 */

import * as vscode from 'vscode';
import type { JobHistoryEntry, SessionEntry } from '@agentvoice/client';
import { errorMessage, type BridgeConnection } from './bridge.js';

interface SessionLogEntry {
  at: string;
  level: string;
  summary: string;
  detail?: string;
}

type Node =
  | { kind: 'group'; id: string; label: string; icon: string }
  | { kind: 'voice'; label: string; description: string }
  | { kind: 'job'; job: { jobId: string; prompt: string; activity: string | null; elapsedMs: number; mode: string } }
  | { kind: 'history'; job: JobHistoryEntry }
  | { kind: 'session'; session: SessionEntry; active: boolean; project: string }
  | { kind: 'info'; label: string };

export class SessionsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private history: JobHistoryEntry[] = [];
  private sessions: SessionEntry[] = [];
  private activeSession: string | null = null;
  private sessionsProject: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly bridge: BridgeConnection) {
    this.disposables.push(
      bridge.onState(() => this.scheduleRefresh()),
      bridge.onFrame((frame) => {
        if (frame.type === 'voice_agent_status' || frame.type === 'turn_complete') this.scheduleRefresh();
      }),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 400);
  }

  async refresh(): Promise<void> {
    const state = this.bridge.state;
    if (this.bridge.status !== 'connected' || !state) {
      this.changeEmitter.fire();
      return;
    }
    try {
      const project = state.activeProject ?? undefined;
      const [hist, sess] = await Promise.all([
        this.bridge.http.jobsHistory(project, 15),
        project ? this.bridge.http.sessions(project) : Promise.resolve(null),
      ]);
      this.history = hist.jobs;
      this.sessions = sess?.sessions ?? [];
      this.activeSession = sess?.active_session_id ?? null;
      this.sessionsProject = project ?? null;
    } catch (err) {
      this.bridge.log(`sessions refresh failed: ${errorMessage(err)}`);
    }
    this.changeEmitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.id = node.id;
        return item;
      }
      case 'voice': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('broadcast');
        return item;
      }
      case 'job': {
        const item = new vscode.TreeItem(node.job.prompt.slice(0, 80));
        item.description = `${node.job.mode} · ${Math.round(node.job.elapsedMs / 1000)}s`;
        item.tooltip = node.job.activity ?? node.job.prompt;
        item.iconPath = new vscode.ThemeIcon('sync~spin');
        return item;
      }
      case 'history': {
        const j = node.job;
        const item = new vscode.TreeItem(j.prompt.slice(0, 80));
        const icon = j.status === 'done' ? 'pass' : j.status === 'error' ? 'error' : j.status === 'running' ? 'sync~spin' : 'circle-slash';
        item.iconPath = new vscode.ThemeIcon(icon);
        item.description = `${j.status} · ${new Date(j.started_at).toLocaleString()}`;
        item.tooltip = [j.summary, j.error].filter(Boolean).join('\n') || j.prompt;
        return item;
      }
      case 'session': {
        const s = node.session;
        const item = new vscode.TreeItem((s.last_prompt || s.session_id).slice(0, 80));
        item.description = `${node.active ? '● ' : ''}${s.job_count} run${s.job_count === 1 ? '' : 's'} · ${new Date(s.last_run_at).toLocaleDateString()}`;
        item.tooltip = `${s.session_id}\n${s.last_prompt}`;
        item.iconPath = new vscode.ThemeIcon(node.active ? 'debug-breakpoint-log' : 'history');
        item.contextValue = 'session';
        // Clicking reads the thread; resuming is the deliberate action.
        item.command = { command: 'agentvoice.examineSession', title: 'Examine thread', arguments: [node] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    const state = this.bridge.state;
    if (!node) {
      return [
        { kind: 'group', id: 'running', label: 'Running', icon: 'pulse' },
        { kind: 'group', id: 'history', label: 'Recent jobs', icon: 'history' },
        { kind: 'group', id: 'sessions', label: `Threads${this.sessionsProject ? ` · ${this.sessionsProject}` : ''}`, icon: 'comment-discussion' },
      ];
    }
    if (node.kind !== 'group') return [];
    if (node.id === 'running') {
      const out: Node[] = [];
      if (state?.voice_agent) {
        out.push({
          kind: 'voice',
          label: `${state.provider.displayName} (conversation)`,
          description: `pid ${state.voice_agent.pid}${state.listening ? ' · listening' : ''}${state.pending_user_turns ? ` · ${state.pending_user_turns} queued` : ''}`,
        });
      }
      for (const j of state?.jobs ?? []) out.push({ kind: 'job', job: j });
      return out.length ? out : [{ kind: 'info', label: 'Idle' }];
    }
    if (node.id === 'history') {
      return this.history.length ? this.history.map((job) => ({ kind: 'history', job })) : [{ kind: 'info', label: 'No jobs yet' }];
    }
    return this.sessions.length
      ? this.sessions.map((session) => ({ kind: 'session', session, active: session.session_id === this.activeSession, project: this.sessionsProject ?? '' }))
      : [{ kind: 'info', label: this.sessionsProject ? 'No threads yet' : 'No project selected' }];
  }

  /** Open a thread's history as a document — spoken turns included. */
  async examineSession(node: Node | undefined): Promise<void> {
    if (!node || node.kind !== 'session') return;
    const s = node.session;
    const query = new URLSearchParams({ project: node.project, session_id: s.session_id });
    const { entries } = await this.bridge.http.get<{ entries: SessionLogEntry[] }>(
      `/api/agent-sessions/logs?${query}`,
    );
    const header = [
      `Thread ${s.session_id}`,
      `Project: ${node.project}`,
      `Runs:    ${s.job_count} · last ${new Date(s.last_run_at).toLocaleString()} · ${s.last_status}`,
      node.active ? 'This is the active thread — the next turn continues it.' : '',
      '',
    ].filter(Boolean);
    const body = entries.length
      ? entries.map((e) => `${e.at}  [${e.level}] ${e.summary}${e.detail ? `\n${' '.repeat(21)}${e.detail}` : ''}`)
      : ['(no recorded activity for this thread)'];
    const doc = await vscode.workspace.openTextDocument({
      content: [...header, ...body].join('\n'),
      language: 'log',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async selectSession(node: Node | undefined): Promise<void> {
    if (!node || node.kind !== 'session') return;
    const result = await this.bridge.http.selectSession(node.project, node.session.session_id);
    void vscode.window.showInformationMessage(`AgentVoice: ${result.message}`);
    await this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.changeEmitter.dispose();
  }
}
