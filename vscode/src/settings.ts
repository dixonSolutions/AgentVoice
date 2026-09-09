/**
 * Settings view — the bridge's configuration, rendered natively.
 *
 * This does not frame the web app. It reads `GET /api/config` (the validated
 * config.json the bridge actually runs on) and renders the fields declared in
 * settingsFields.ts with plain VS Code-styled controls, so it works whether or
 * not the Angular dev server is up.
 *
 * Saving is read-modify-write: re-GET, apply only the paths the user touched,
 * PUT the whole document back. That endpoint replaces the file, so sending a
 * stale copy would silently revert whatever the phone or another editor
 * changed while this tab sat open.
 *
 * Bridge URL and token are the exception — they say *how to reach* the bridge,
 * so they cannot live inside it. Those stay native (settings + SecretStorage).
 */

import * as vscode from 'vscode';
import { errorMessage, readSettings, type BridgeConnection } from './bridge.js';
import { SECTIONS, type Field } from './settingsFields.js';

interface AgentClientStatus {
  active: string;
  clients: { id: string; label: string; available: boolean; binPath: string | null }[];
}

type ConfigDoc = Record<string, unknown>;

/** Read a dotted path out of the config document. */
function getPath(doc: ConfigDoc, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Write a dotted path, creating intermediate objects as needed. */
function setPath(doc: ConfigDoc, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let cur: Record<string, unknown> = doc;
  for (const key of keys) {
    const next = cur[key];
    if (next === null || typeof next !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** Turn a webview value back into the shape config.json expects. */
function coerce(field: Field, raw: unknown): unknown {
  if (field.type === 'list') {
    const text = typeof raw === 'string' ? raw : '';
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (field.type === 'number') return raw === null || raw === '' ? undefined : Number(raw);
  if (field.type === 'boolean') return raw === true;
  // An emptied text box means "unset", not the empty string — several of these
  // are `.optional()` in the schema and would fail a min(1) check.
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  return raw;
}

export class SettingsView {
  private panel: vscode.WebviewPanel | null = null;
  private readonly savedEmitter = new vscode.EventEmitter<void>();
  /** Fires after config.json is written, so live consumers can re-read it. */
  readonly onSaved = this.savedEmitter.event;

  constructor(private readonly bridge: BridgeConnection) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentvoice.settings', 'AgentVoice Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
    });
    panel.webview.onDidReceiveMessage((msg: { type?: string; values?: Record<string, unknown> }) => {
      void this.onMessage(msg);
    });
    panel.webview.html = this.html();
  }

  private async onMessage(msg: { type?: string; values?: Record<string, unknown> }): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
        case 'reload':
          await this.load();
          return;
        case 'save':
          await this.save(msg.values ?? {});
          return;
        case 'set-url':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'agentvoice.bridgeUrl');
          return;
        case 'set-token':
          await vscode.commands.executeCommand('agentvoice.setToken');
          return;
      }
    } catch (err) {
      this.post({ type: 'error', message: errorMessage(err) });
    }
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private async load(): Promise<void> {
    if (!this.panel) return;
    if (this.bridge.status !== 'connected') {
      this.post({ type: 'offline', baseUrl: readSettings().bridgeUrl, status: this.bridge.status });
      return;
    }
    try {
      const [config, agents] = await Promise.all([
        this.bridge.http.get<ConfigDoc>('/api/config'),
        // The client list is the bridge's to answer — never a literal in here.
        this.bridge.http.get<AgentClientStatus>('/api/admin/agent-client').catch(() => null),
      ]);
      const values: Record<string, unknown> = {};
      for (const section of SECTIONS) {
        for (const field of section.fields) values[field.path] = getPath(config, field.path) ?? null;
      }
      this.post({
        type: 'config',
        baseUrl: readSettings().bridgeUrl,
        values,
        agentClients: (agents?.clients ?? []).map((c) => ({
          value: c.id,
          label: c.available ? c.label : `${c.label} (not installed)`,
        })),
      });
    } catch (err) {
      this.post({ type: 'error', message: errorMessage(err) });
    }
  }

  private async save(values: Record<string, unknown>): Promise<void> {
    const fresh = await this.bridge.http.get<ConfigDoc>('/api/config');
    const known = new Map<string, Field>();
    for (const section of SECTIONS) for (const f of section.fields) known.set(f.path, f);

    for (const [path, raw] of Object.entries(values)) {
      const field = known.get(path);
      if (!field) continue;
      setPath(fresh, path, coerce(field, raw));
    }

    await this.bridge.http.request('/api/config', { method: 'PUT', body: JSON.stringify(fresh) });
    this.post({ type: 'saved' });
    // A running voice session read this config when it started — tell it to
    // re-read, so toggling wake words takes effect now rather than on restart.
    this.savedEmitter.fire();
    await this.bridge.refreshState();
    await this.load();
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ');
    const spec = JSON.stringify(SECTIONS);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentVoice Settings</title>
<style>
  :root { --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.25))); }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
         padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--vscode-editor-background); }
  .bar .url { font-size: 11px; opacity: .6; margin-right: auto; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 16px; }
  input[type=text], input[type=number], select {
    width: 100%; font-family: inherit; font-size: 12px; padding: 4px 6px; border-radius: 4px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--border)); }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { font-family: inherit; font-size: 12px; border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  h2 { font-size: 13px; margin: 22px 0 2px; }
  .blurb { font-size: 11px; opacity: .6; margin-bottom: 10px; }
  .row { display: grid; grid-template-columns: minmax(150px, 230px) 1fr; gap: 10px; align-items: start;
         padding: 7px 0; border-top: 1px solid var(--border); }
  .row label { font-size: 12px; padding-top: 4px; }
  .hint { font-size: 11px; opacity: .55; margin-top: 3px; }
  .unit { font-size: 11px; opacity: .55; margin-left: 6px; }
  .field { display: flex; align-items: center; }
  .field input[type=checkbox] { margin: 0 6px 0 0; }
  .dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground); font-weight: 600; }
  .msg { padding: 8px 16px; font-size: 12px; }
  .msg.err { color: var(--vscode-errorForeground); }
  .msg.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
  .search { width: 100%; margin-bottom: 6px; }
  .empty { opacity: .6; font-style: italic; padding: 24px 0; }
</style>
</head>
<body>
<div class="bar">
  <span class="url" id="url"></span>
  <button id="seturl">Bridge URL</button>
  <button id="settoken">Set token</button>
  <button id="reload">Reload</button>
  <button id="save" class="primary" disabled>Save</button>
</div>
<div id="msg" class="msg" hidden></div>
<div class="wrap">
  <input type="text" class="search" id="search" placeholder="Search settings…">
  <div id="body"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SECTIONS = ${spec};
const $ = (id) => document.getElementById(id);
let values = {};
let dirty = {};
let agentClients = [];

function optionsFor(field) {
  if (field.optionsFrom === 'agentClients') return agentClients;
  return (field.options || []).map((o) => ({ value: o, label: o }));
}

function mark(path, value) {
  dirty[path] = value;
  $('save').disabled = false;
  const label = document.querySelector('[data-label="' + path + '"]');
  if (label) label.classList.add('dirty');
}

function control(field) {
  const v = field.path in dirty ? dirty[field.path] : values[field.path];
  if (field.type === 'boolean') {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = v === true;
    el.addEventListener('change', () => mark(field.path, el.checked));
    return el;
  }
  if (field.type === 'select') {
    const el = document.createElement('select');
    const opts = optionsFor(field);
    if (opts.length === 0) {
      const o = document.createElement('option');
      o.value = String(v ?? ''); o.textContent = String(v ?? '(bridge did not answer)');
      el.append(o);
      el.disabled = true;
      return el;
    }
    for (const opt of opts) {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label; o.selected = opt.value === v;
      el.append(o);
    }
    el.addEventListener('change', () => mark(field.path, el.value));
    return el;
  }
  if (field.type === 'number') {
    const el = document.createElement('input');
    el.type = 'number';
    if (field.min !== undefined) el.min = String(field.min);
    if (field.max !== undefined) el.max = String(field.max);
    el.step = 'any';
    el.value = v === null || v === undefined ? '' : String(v);
    el.addEventListener('input', () => mark(field.path, el.value === '' ? '' : Number(el.value)));
    return el;
  }
  const el = document.createElement('input');
  el.type = 'text';
  if (field.type === 'list') {
    el.value = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
    el.placeholder = 'comma separated';
  } else {
    el.value = v === null || v === undefined ? '' : String(v);
  }
  el.addEventListener('input', () => mark(field.path, el.value));
  return el;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const body = $('body');
  body.replaceChildren();
  let shown = 0;
  for (const section of SECTIONS) {
    const fields = section.fields.filter((f) =>
      !q || f.label.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) ||
      section.title.toLowerCase().includes(q));
    if (fields.length === 0) continue;
    shown += fields.length;
    const h = document.createElement('h2');
    h.textContent = section.title;
    const b = document.createElement('div');
    b.className = 'blurb';
    b.textContent = section.blurb;
    body.append(h, b);
    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = field.label;
      label.dataset.label = field.path;
      label.title = field.path;
      if (field.path in dirty) label.classList.add('dirty');
      const cell = document.createElement('div');
      const line = document.createElement('div');
      line.className = 'field';
      line.append(control(field));
      if (field.unit) {
        const u = document.createElement('span');
        u.className = 'unit';
        u.textContent = field.unit;
        line.append(u);
      }
      cell.append(line);
      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = field.hint;
        cell.append(hint);
      }
      row.append(label, cell);
      body.append(row);
    }
  }
  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No settings match.';
    body.append(empty);
  }
}

function message(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
  el.hidden = !text;
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'config') {
    values = m.values; agentClients = m.agentClients || []; dirty = {};
    $('url').textContent = m.baseUrl;
    $('save').disabled = true;
    render();
  } else if (m.type === 'offline') {
    $('url').textContent = m.baseUrl;
    message('Not connected (' + m.status + '). These settings live on the bridge, so there is nothing to show until it answers.', 'err');
    $('body').replaceChildren();
  } else if (m.type === 'saved') {
    message('Saved to config.json.', 'ok');
  } else if (m.type === 'error') {
    message(m.message, 'err');
  }
});

$('save').addEventListener('click', () => {
  $('save').disabled = true;
  message('Saving…');
  vscode.postMessage({ type: 'save', values: dirty });
});
$('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
$('seturl').addEventListener('click', () => vscode.postMessage({ type: 'set-url' }));
$('settoken').addEventListener('click', () => vscode.postMessage({ type: 'set-token' }));
$('search').addEventListener('input', render);
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
