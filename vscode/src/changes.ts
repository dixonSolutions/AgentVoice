/**
 * Changes view — files the agent wrote this session, opened in the native
 * diff editor against HEAD (via the built-in git extension), plus a refresh
 * from the bridge's `agent_diff` diffstat.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AgentEventFrame } from '@agentvoice/client';
import { errorMessage, type BridgeConnection } from './bridge.js';

interface GitRepository {
  rootUri: vscode.Uri;
  show(ref: string, filePath: string): Promise<string>;
}

interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

function gitApi(): GitApi | null {
  const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>('vscode.git');
  if (!ext) return null;
  try {
    return ext.exports.getAPI(1);
  } catch {
    return null;
  }
}

export const HEAD_SCHEME = 'agentvoice-head';

export class HeadContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const api = gitApi();
    const fileUri = vscode.Uri.file(uri.path);
    const repo = api?.getRepository(fileUri);
    if (!repo) return '';
    try {
      return await repo.show('HEAD', fileUri.fsPath);
    } catch {
      // New file → empty on the left side.
      return '';
    }
  }
}

export interface ChangedFile {
  fsPath: string;
  label: string;
  writes: number;
  lastAt: string;
  source: string;
}

export class ChangesProvider implements vscode.TreeDataProvider<ChangedFile>, vscode.Disposable {
  private readonly files = new Map<string, ChangedFile>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly bridge: BridgeConnection) {
    this.disposables.push(
      bridge.onFrame((frame) => {
        if (frame.type !== 'agent_event') return;
        const f = frame as AgentEventFrame;
        if (f.event.kind === 'tool_start' && f.event.tool.action === 'write' && f.event.tool.path) {
          this.record(f.event.tool.path, f.source, f.ts ?? new Date().toISOString());
        }
      }),
      bridge.onStatus((s) => {
        if (s === 'connected') void this.refreshFromGit();
      }),
    );
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) return p;
    const base = this.bridge.workspaceProject?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.join(base, p);
  }

  record(p: string, source: string, at: string): void {
    const fsPath = this.resolvePath(p);
    const existing = this.files.get(fsPath);
    if (existing) {
      existing.writes += 1;
      existing.lastAt = at;
      existing.source = source;
    } else {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
      this.files.set(fsPath, {
        fsPath,
        label: folder ? path.relative(folder.uri.fsPath, fsPath) : p,
        writes: 1,
        lastAt: at,
        source,
      });
    }
    this.changeEmitter.fire();
  }

  /** Seed from the project's uncommitted diffstat (files changed before we connected). */
  async refreshFromGit(): Promise<void> {
    if (this.bridge.status !== 'connected' || !this.bridge.state?.activeProject) return;
    try {
      const diff = await this.bridge.http.diff(false);
      if (diff.clean) {
        this.changeEmitter.fire();
        return;
      }
      for (const line of diff.diffstat.split('\n')) {
        const m = /^\s*(.+?)\s+\|\s+\d+/.exec(line);
        if (m?.[1]) this.record(m[1].trim(), 'git', new Date().toISOString());
      }
    } catch (err) {
      this.bridge.log(`diff refresh failed: ${errorMessage(err)}`);
    }
  }

  clear(): void {
    this.files.clear();
    this.changeEmitter.fire();
  }

  getTreeItem(el: ChangedFile): vscode.TreeItem {
    const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(el.fsPath);
    item.description = `${el.writes} write${el.writes === 1 ? '' : 's'} · ${el.source}`;
    item.tooltip = `${el.fsPath}\nlast write ${el.lastAt}`;
    item.contextValue = 'file';
    item.iconPath = vscode.ThemeIcon.File;
    item.command = { command: 'agentvoice.openDiff', title: 'Open diff', arguments: [el] };
    return item;
  }

  getChildren(): ChangedFile[] {
    return [...this.files.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.changeEmitter.dispose();
  }
}

export async function openDiff(file: ChangedFile | { fsPath: string } | undefined): Promise<void> {
  const fsPath = file?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!fsPath) return;
  const right = vscode.Uri.file(fsPath);
  const left = vscode.Uri.from({ scheme: HEAD_SCHEME, path: fsPath });
  const name = path.basename(fsPath);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ working tree)`, { preview: true });
}
