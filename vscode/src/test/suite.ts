/**
 * Integration suite — runs inside a real VS Code (via @vscode/test-electron)
 * against a running bridge. Exercises the extension host code paths the
 * headless bridge tests cannot: activation, secret storage, the connection
 * manager, workspace-as-project, command registration, the approval relay,
 * and (with AGENTVOICE_LIVE=1) a full typed-turn round trip with a relayed
 * permission prompt answered from the editor.
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { ApprovalRequest, DeskFrame } from '@agentvoice/client';
import type { AgentVoiceApi } from '../extension.js';

const BRIDGE_URL = process.env['AGENTVOICE_BRIDGE_URL'] ?? 'http://127.0.0.1:5089';
const TOKEN = process.env['AGENTVOICE_TOKEN'] ?? '';
const LIVE = process.env['AGENTVOICE_LIVE'] === '1';

function until<T>(label: string, fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = (): void => {
      const v = fn();
      if (v) return resolvePromise(v as T);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function api(): Promise<AgentVoiceApi> {
  const ext = vscode.extensions.getExtension<AgentVoiceApi>('dixonsolutions.agentvoice');
  assert.ok(ext, 'extension dixonsolutions.agentvoice is installed');
  return ext.activate();
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000 });
  const suite = Mocha.Suite.create(mocha.suite, 'AgentVoice extension');

  suite.addTest(
    new Mocha.Test('activates and exports its API', async () => {
      const a = await api();
      assert.ok(a.bridge && a.approvals && a.panel && a.commands, 'api shape');
    }),
  );

  suite.addTest(
    new Mocha.Test('registers its commands', async () => {
      await api();
      const all = await vscode.commands.getCommands(true);
      for (const id of [
        'agentvoice.connect',
        'agentvoice.setToken',
        'agentvoice.ask',
        'agentvoice.sendSelection',
        'agentvoice.sendFile',
        'agentvoice.sendDiagnostics',
        'agentvoice.useWorkspaceAsProject',
        'agentvoice.pickModel',
        'agentvoice.pickPermissionMode',
        'agentvoice.openDiff',
        'agentvoice.refresh',
      ]) {
        assert.ok(all.includes(id), `command ${id}`);
      }
    }),
  );

  suite.addTest(
    new Mocha.Test('connects with a stored token and reads the desk snapshot', async () => {
      const a = await api();
      await vscode.workspace.getConfiguration('agentvoice').update('bridgeUrl', BRIDGE_URL, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('agentvoice').update('notifications', false, vscode.ConfigurationTarget.Workspace);
      await a.bridge.setToken(TOKEN);
      assert.ok(await a.bridge.connect(), 'connect() accepted the token');
      await until('socket connected', () => a.bridge.status === 'connected', 20_000);
      const state = await until('state snapshot', () => a.bridge.state, 10_000);
      assert.equal(state.workflow, 'agent_native');
      assert.ok(state.provider.id, 'provider id present');
      assert.ok(state.permissionMode.id, 'permission mode present');
    }),
  );

  suite.addTest(
    new Mocha.Test('makes the open workspace folder the active project (ephemeral registration)', async () => {
      const a = await api();
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder, 'a workspace folder is open');
      await until('workspace registered', () => a.bridge.workspaceProject, 20_000);
      const state = await a.bridge.refreshState();
      assert.ok(state, 'state after refresh');
      assert.equal(state.activeProject, a.bridge.workspaceProject?.name);
      assert.equal(a.bridge.workspaceProject?.path, folder.uri.fsPath);
      const lookup = await a.bridge.http.workspaceProject(folder.uri.fsPath);
      assert.equal(lookup.project?.name, state.activeProject);
    }),
  );

  suite.addTest(
    new Mocha.Test('REST client: models, permission modes, jobs, sessions all answer', async () => {
      const a = await api();
      const modes = await a.bridge.http.permissionModes();
      assert.ok(modes.modes.length >= 1);
      const jobs = await a.bridge.http.jobsHistory(undefined, 5);
      assert.ok(Array.isArray(jobs.jobs));
      const project = a.bridge.state?.activeProject;
      assert.ok(project);
      const sessions = await a.bridge.http.sessions(project);
      assert.equal(sessions.project, project);
      const projects = await a.bridge.http.projects();
      assert.ok(projects.some((p) => p.name === project), 'ephemeral project is listed like any other');
    }),
  );

  suite.addTest(
    new Mocha.Test('approval relay: unknown id is reported, pending list mirrors the bridge', async () => {
      const a = await api();
      assert.equal(a.approvals.pendingCount(), (await a.bridge.http.pendingApprovals()).length);
      const ok = await a.approvals.respond('does-not-exist', { kind: 'permission', decision: 'deny' });
      assert.equal(ok, false);
    }),
  );

  suite.addTest(
    new Mocha.Test('changes view: records agent writes and resolves relative paths against the workspace', async () => {
      const a = await api();
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      a.changes.clear();
      a.changes.record('docs/34-vscode-extension.md', 'test', new Date().toISOString());
      const items = a.changes.getChildren();
      assert.equal(items.length, 1);
      assert.equal(items[0]?.fsPath, path.join(a.bridge.workspaceProject?.path ?? folder.uri.fsPath, 'docs/34-vscode-extension.md'));
      const item = a.changes.getTreeItem(items[0]!);
      assert.equal(item.contextValue, 'file');
      a.changes.clear();
    }),
  );

  suite.addTest(
    new Mocha.Test('panel view can be shown', async () => {
      await api();
      await vscode.commands.executeCommand('agentvoice.panel.focus');
    }),
  );

  if (LIVE) {
    suite.addTest(
      new Mocha.Test('LIVE: typed turn → relayed permission prompt answered from the editor → spoken result', async function (this: Mocha.Context) {
        this.timeout(180_000);
        const a = await api();
        const frames: DeskFrame[] = [];
        const pending: ApprovalRequest[] = [];
        const offFrame = a.bridge.onFrame((f) => frames.push(f));
        const offApproval = a.approvals.onChange((list) => {
          for (const r of list) if (!pending.some((p) => p.request_id === r.request_id)) pending.push(r);
        });
        try {
          await a.commands.submit(
            'Use your Bash tool to run exactly: curl -s http://127.0.0.1:5089/healthz — then tell me the value of the status field in one sentence and call done.',
          );
          const req = await until('permission request', () => pending.find((p) => p.kind === 'permission'), 120_000);
          assert.equal(req.kind, 'permission');
          assert.ok(/curl/.test((req as { summary: string }).summary), `summary mentions curl: ${(req as { summary: string }).summary}`);
          assert.ok(await a.approvals.respond(req.request_id, { kind: 'permission', decision: 'allow' }), 'answer accepted');
          await until('approval cleared', () => a.approvals.pendingCount() === 0, 10_000);
          const spoken = await until(
            'spoken result',
            () => frames.find((f) => f.type === 'speak' && /ok/i.test((f as { text: string }).text)),
            120_000,
          );
          assert.ok(spoken);
          await until('turn complete', () => frames.some((f) => f.type === 'turn_complete'), 60_000);
        } finally {
          offFrame.dispose();
          offApproval.dispose();
        }
      }),
    );
  }

  return new Promise((resolvePromise, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolvePromise()));
  });
}
