/**
 * Panel webview: read-along transcript, approvals, activity feed, composer.
 *
 * Runs the shared ReadAlongModel. "Read" progress comes from whichever voice
 * is active — bridge TTS audio (timing spread across the clip), the editor's
 * speechSynthesis (word boundary events), or the silent pacer.
 */

import {
  ReadAlongModel,
  type AgentEventFrame,
  type ApprovalRequest,
  type ApprovalResponse,
  type DeskFrame,
  type DeskState,
  type ModelEntry,
  type PermissionModeDescriptor,
  type ReadAlongSnapshot,
  type Segment,
  type SessionEntry,
} from '@agentvoice/client';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    // Losing one listener is survivable; a throw here kills the whole script —
    // which is how a stale lookup once silenced read-aloud entirely, by
    // stopping the 'ready' message that fetches config.
    vscode.postMessage({ type: 'log', text: `missing element #${id}` });
    return document.createElement('div') as unknown as T;
  }
  return el as T;
};
const page = $('#page'.slice(1));
const conn = $('conn');
const meta = $('meta');
const bar = $('bar');
const approvalsEl = $('approvals');
const thinkingEl = $('thinking');
const input = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const audioState = $('audio-state');
const controlsEl = $('controls');
const sessionSel = $<HTMLSelectElement>('ctl-session');
const modelSel = $<HTMLSelectElement>('ctl-model');
const effortSel = $<HTMLSelectElement>('ctl-effort');
const effortWrap = $('ctl-effort-wrap');
const fastBox = $<HTMLInputElement>('ctl-fast');
const fastWrap = $('ctl-fast-wrap');
const permSel = $<HTMLSelectElement>('ctl-perm');
const permWrap = $('ctl-perm-wrap');
const orbCanvas = $<HTMLCanvasElement>('orb');
const orbHit = $<HTMLButtonElement>('orbhit');
const orbLabel = $('orb-label');
const penBtn = $<HTMLButtonElement>('pen');
const penBox = $('penbox');
const penCancel = $<HTMLButtonElement>('pencancel');

type ReadAloud = 'off' | 'bridge' | 'browser';
let config: { readAloud: ReadAloud; pacer: boolean } = { readAloud: 'off', pacer: true };
let state: DeskState | null = null;
let approvals: ApprovalRequest[] = [];
const model = new ReadAlongModel({ wpm: 185 });
const rendered = new Map<string, HTMLElement>();

// ── Rendering ─────────────────────────────────────────────────────────────

function renderSegment(seg: Segment, el: HTMLElement): void {
  el.className = `seg ${seg.role} ${seg.state}`;
  // Explicit per-turn state: the word shading only tells you about the line
  // being spoken right now, so an unread marker is what makes a scrolled-back
  // transcript scannable.
  el.dataset['unread'] = seg.role === 'agent' && seg.state === 'unread' ? 'yes' : 'no';
  if (seg.role === 'agent' && (seg.state === 'reading' || seg.state === 'read')) {
    el.replaceChildren(
      ...seg.words.flatMap((w, i) => {
        const span = document.createElement('span');
        span.className = `w${i < seg.wordIndex ? ' done' : ''}${i === seg.wordIndex && seg.state === 'reading' ? ' now' : ''}`;
        span.textContent = w;
        return i < seg.words.length - 1 ? [span, document.createTextNode(' ')] : [span];
      }),
    );
  } else {
    el.textContent = seg.text;
  }
}

function render(snap: ReadAlongSnapshot): void {
  if (snap.segments.length === 0) {
    page.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'The agent has not said anything yet. Type below, or send a selection from the editor.' }));
    rendered.clear();
  } else {
    if (page.querySelector('.empty')) page.replaceChildren();
    const seen = new Set<string>();
    for (const seg of snap.segments) {
      seen.add(seg.id);
      let el = rendered.get(seg.id);
      if (!el) {
        el = document.createElement('p');
        el.dataset['id'] = seg.id;
        rendered.set(seg.id, el);
        page.appendChild(el);
      }
      renderSegment(seg, el);
    }
    for (const [id, el] of rendered) {
      if (!seen.has(id)) {
        el.remove();
        rendered.delete(id);
      }
    }
  }
  bar.style.width = `${Math.round(snap.progress * 100)}%`;
  const reading = snap.readingId ? rendered.get(snap.readingId) : null;
  const last = page.lastElementChild;
  (reading ?? last)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

model.subscribe((snap) => {
  render(snap);
  renderMeta();
});

function renderMeta(): void {
  if (!state) {
    meta.textContent = '';
    return;
  }
  const bits = [
    state.provider.displayName,
    state.activeModel + (state.activeEffort ? ` ${state.activeEffort}` : '') + (state.activeFast ? ' fast' : ''),
    state.activeProject ?? 'no project',
    state.permissionMode.label,
    state.voice_agent ? `pid ${state.voice_agent.pid}` : 'idle',
  ];
  const unread = model.snapshot().segments.filter((sg) => sg.role === 'agent' && sg.state === 'unread').length;
  if (unread > 0) bits.push(`${unread} unread`);
  meta.textContent = bits.join(' · ');
}

// ── Approvals ─────────────────────────────────────────────────────────────

function answer(id: string, response: ApprovalResponse): void {
  vscode.postMessage({ type: 'approval', request_id: id, response });
  approvals = approvals.filter((a) => a.request_id !== id);
  renderApprovals();
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function renderApprovals(): void {
  approvalsEl.hidden = approvals.length === 0;
  approvalsEl.replaceChildren(
    ...approvals.map((req) => {
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'title';
      const body = document.createElement('div');
      body.className = 'body';
      const row = document.createElement('div');
      row.className = 'row';
      switch (req.kind) {
        case 'permission': {
          title.textContent = `${req.provider} wants to run`;
          body.textContent = req.summary;
          row.append(
            button('Allow', 'primary', () => answer(req.request_id, { kind: 'permission', decision: 'allow' })),
            button('Deny', 'danger', () => answer(req.request_id, { kind: 'permission', decision: 'deny' })),
            button('input…', 'link', () => vscode.postMessage({ type: 'approval-detail', request_id: req.request_id })),
          );
          break;
        }
        case 'user_input': {
          title.textContent = 'The agent asks';
          body.textContent = req.question;
          if (req.input_type === 'yesno') {
            row.append(
              button('Yes', 'primary', () => answer(req.request_id, { kind: 'user_input', answer: 'yes' })),
              button('No', '', () => answer(req.request_id, { kind: 'user_input', answer: 'no' })),
            );
          } else if (req.input_type === 'choice' && req.options?.length) {
            for (const opt of req.options) row.append(button(opt, '', () => answer(req.request_id, { kind: 'user_input', answer: opt })));
          } else {
            const field = document.createElement('input');
            field.type = 'text';
            field.placeholder = 'Your answer';
            const send = (): void => {
              if (field.value.trim()) answer(req.request_id, { kind: 'user_input', answer: field.value.trim() });
            };
            field.addEventListener('keydown', (e) => e.key === 'Enter' && send());
            row.append(field, button('Answer', 'primary', send));
          }
          break;
        }
        case 'plan_approval': {
          title.textContent = `Plan: ${req.title}`;
          const ol = document.createElement('ol');
          for (const s of req.steps) ol.append(Object.assign(document.createElement('li'), { textContent: s }));
          body.replaceChildren(ol, document.createTextNode(req.estimated_impact ?? ''));
          const notes = document.createElement('input');
          notes.type = 'text';
          notes.placeholder = 'Notes (for modify / reject)';
          row.append(
            button('Approve', 'primary', () => answer(req.request_id, { kind: 'plan_approval', decision: 'approved' })),
            button('Modify', '', () => answer(req.request_id, { kind: 'plan_approval', decision: 'modified', notes: notes.value })),
            button('Reject', 'danger', () => answer(req.request_id, { kind: 'plan_approval', decision: 'rejected', notes: notes.value })),
            notes,
          );
          break;
        }
        case 'secret_input': {
          title.textContent = `${req.agent ?? 'The agent'} needs a ${req.source} password`;
          body.textContent = req.prompt;
          const field = document.createElement('input');
          field.type = 'password';
          field.autocomplete = 'off';
          const send = (): void => {
            const secret = field.value;
            field.value = '';
            answer(req.request_id, { kind: 'secret_input', secret });
          };
          field.addEventListener('keydown', (e) => e.key === 'Enter' && send());
          row.append(field, button('Send', 'primary', send), button('Cancel', '', () => answer(req.request_id, { kind: 'secret_input', secret: null })));
          break;
        }
      }
      card.append(title, body, row);
      return card;
    }),
  );
}

// ── Activity feed ─────────────────────────────────────────────────────────

/**
 * Tool activity goes to the AgentVoice output channel, not the panel. The
 * panel is for the conversation — burying the agent's words under a live feed
 * of every file read is what "too in the face" meant.
 */
function addActivity(kind: string, text: string, opts: { cls?: string; path?: string } = {}): void {
  vscode.postMessage({ type: 'activity', kind, text, path: opts.path ?? null, level: opts.cls ?? null });
}

function describeAgentEvent(f: AgentEventFrame): { kind: string; text: string; cls?: string; path?: string } | null {
  const e = f.event;
  const who = f.source === 'voice' ? 'agent' : 'worker';
  switch (e.kind) {
    case 'init':
      return { kind: who, text: `started${e.model ? ` (${e.model})` : ''}` };
    case 'session':
      return null;
    case 'tool_start': {
      const t = e.tool;
      if (t.action === 'write') return { kind: 'write', text: t.path ?? t.name, cls: 'write', path: t.path };
      if (t.action === 'read') return { kind: 'read', text: t.path ?? t.name, path: t.path };
      if (t.action === 'search') return { kind: 'search', text: t.path ?? t.name };
      if (t.action === 'shell') return { kind: 'run', text: t.command ?? t.name };
      if (t.action === 'task') return { kind: 'task', text: t.subagent ?? t.name };
      return { kind: 'tool', text: t.name };
    }
    case 'tool_done':
      return e.success === false ? { kind: 'tool', text: `${e.tool.name} failed`, cls: 'error' } : null;
    case 'assistant_text':
      // Spoken lines come through `speak`; worker prose goes to the feed.
      return f.source === 'worker' ? { kind: 'worker', text: e.text.slice(0, 200) } : null;
    case 'result':
      return { kind: who, text: e.text ? `done: ${e.text.slice(0, 200)}` : 'done' };
    case 'error':
      return { kind: who, text: e.message, cls: 'error' };
  }
}

// ── Voice output ──────────────────────────────────────────────────────────

let speechTimer: number | null = null;
let speakingSeg: string | null = null;
const pendingTts = new Map<string, string>();
let ttsSeq = 0;

function stopAudio(): void {
  if (speechTimer !== null) {
    clearInterval(speechTimer);
    speechTimer = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  vscode.postMessage({ type: 'speech-stop' });
  speakingSeg = null;
  audioState.textContent = '';
}

/** Read the next unread agent line with the configured voice, chaining until none are left. */
function readNext(): void {
  if (speakingSeg) return;
  const seg = model.startReading();
  if (!seg) {
    audioState.textContent = '';
    return;
  }
  speakingSeg = seg.id;
  if (config.readAloud === 'browser' && 'speechSynthesis' in window) {
    const utter = new SpeechSynthesisUtterance(seg.text);
    utter.onboundary = (ev) => {
      if (ev.name === 'word') model.advance({ charIndex: ev.charIndex });
    };
    utter.onend = () => {
      model.markRead(seg.id);
      speakingSeg = null;
      readNext();
    };
    utter.onerror = (ev) => {
      audioState.textContent = `speech error: ${ev.error}`;
      model.markRead(seg.id);
      speakingSeg = null;
      if (ev.error !== 'canceled' && ev.error !== 'interrupted') {
        // No voices available → fall back to pacing.
        config = { ...config, readAloud: 'off' };
        if (config.pacer) model.startPacer();
      }
    };
    audioState.textContent = 'speaking (editor voice)';
    window.speechSynthesis.speak(utter);
    return;
  }
  if (config.readAloud === 'bridge') {
    const id = `tts-${++ttsSeq}`;
    pendingTts.set(id, seg.id);
    audioState.textContent = 'fetching speech…';
    vscode.postMessage({ type: 'speak', id, text: seg.text });
    return;
  }
  // Silent — let the pacer own it.
  speakingSeg = null;
  if (config.pacer) model.startPacer();
}

/**
 * Speech now plays in the extension host (src/audioOut.ts) — a webview never
 * reliably holds the user activation VS Code's autoplay policy demands, which
 * is what "sound is blocked by the editor" was. The panel only paces the
 * read-along across the clip the host reports.
 */
function onSpeech(msg: { id: string; phase: string; durationMs?: number; provider?: string | null; message?: string }): void {
  const segId = pendingTts.get(msg.id);
  if (msg.phase === 'start') {
    audioState.textContent = `speaking (${msg.provider ?? 'bridge'})`;
    if (!segId) return;
    const seg = model.snapshot().segments.find((sg) => sg.id === segId);
    const words = seg?.words.length ?? 1;
    const started = performance.now();
    const total = msg.durationMs && msg.durationMs > 0 ? msg.durationMs : words * 340;
    if (speechTimer !== null) clearInterval(speechTimer);
    speechTimer = window.setInterval(() => {
      const frac = Math.min(1, (performance.now() - started) / total);
      model.advance({ wordIndex: Math.floor(frac * words) });
      if (frac >= 1 && speechTimer !== null) {
        clearInterval(speechTimer);
        speechTimer = null;
      }
    }, 80);
    return;
  }
  if (speechTimer !== null) {
    clearInterval(speechTimer);
    speechTimer = null;
  }
  pendingTts.delete(msg.id);
  audioState.textContent = msg.phase === 'error' ? `speech failed: ${msg.message ?? ''}` : '';
  if (segId) {
    model.markRead(segId);
    speakingSeg = null;
    readNext();
  }
}

function onNewAgentLine(): void {
  if (config.readAloud === 'off') {
    if (config.pacer) model.startPacer();
    return;
  }
  readNext();
}

// ── Frames ────────────────────────────────────────────────────────────────

function onFrame(frame: DeskFrame): void {
  switch (frame.type) {
    case 'auth_ok':
    case 'pong':
      state = frame as unknown as DeskState;
      renderMeta();
      if (frame.type === 'auth_ok') {
        approvals = state.pending ?? [];
        renderApprovals();
      }
      return;
    case 'speak':
      model.addAgent((frame as { text: string }).text);
      onNewAgentLine();
      return;
    case 'assistant_transcript':
      return; // duplicate of speak
    case 'user_turn': {
      const f = frame as { text: string; source: string };
      model.addUser(f.source === 'desk' ? f.text : `(${f.source}) ${f.text}`);
      return;
    }
    case 'narration': {
      const f = frame as { text: string; kind?: string };
      model.addNarration(f.text, f.kind);
      onNewAgentLine();
      return;
    }
    case 'thinking':
      thinkingEl.hidden = !(frame as { value: boolean }).value;
      return;
    case 'turn_complete':
      thinkingEl.hidden = true;
      sendBtn.disabled = false;
      return;
    case 'turn_accepted':
      sendBtn.disabled = false;
      return;
    case 'tool_activity': {
      const f = frame as { tool: string; phase: string; label?: string; detail?: string };
      if (f.tool !== 'speak') addActivity(f.tool.replace(/_/g, ' '), `${f.label ?? f.phase}${f.detail ? ` — ${f.detail}` : ''}`);
      return;
    }
    case 'voice_agent_status': {
      const f = frame as { state: string; pid: number; provider_name: string };
      model.addSystem(`${f.provider_name} ${f.state} (pid ${f.pid})`);
      if (f.state === 'done' || f.state === 'error' || f.state === 'stopped') {
        thinkingEl.hidden = true;
        sendBtn.disabled = false;
      }
      return;
    }
    case 'agent_event': {
      const d = describeAgentEvent(frame as AgentEventFrame);
      if (d) addActivity(d.kind, d.text, { cls: d.cls, path: d.path });
      return;
    }
    case 'approval_cancelled': {
      const id = (frame as { request_id: string | null }).request_id;
      approvals = id ? approvals.filter((a) => a.request_id !== id) : [];
      renderApprovals();
      return;
    }
    case 'error': {
      const f = frame as { message: string; code?: string };
      model.addSystem(`error: ${f.message}`, f.code);
      sendBtn.disabled = false;
      return;
    }
    default:
      if (frame.type.endsWith('_request')) {
        // Approvals arrive via the host's relay (`approvals` message) — nothing to do here.
      }
  }
}

// ── Composer controls ─────────────────────────────────────────────────────

/**
 * Session / model / permission selects, mirroring the PWA's "Project & session"
 * block. Every option here is relayed from the bridge, which reads it from the
 * active CLI — nothing per-provider is hardcoded (docs/24).
 */
interface Controls {
  connected: boolean;
  project?: string | null;
  sessions?: SessionEntry[];
  activeSession?: string | null;
  models?: ModelEntry[];
  activeModel?: string;
  activeEffort?: string | null;
  activeFast?: boolean;
  modes?: PermissionModeDescriptor[];
  activeMode?: string;
}

let controls: Controls = { connected: false };
/** Set while renderControls() writes the selects, so change events stay quiet. */
let applyingControls = false;

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  el.selected = selected;
  return el;
}

/** "fix the panel composer" → "fix the panel composer" but never wider than the sidebar. */
function shortPrompt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 44 ? `${line.slice(0, 43)}…` : line || 'no prompt';
}

function sinceLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
}

function selectedModel(): ModelEntry | null {
  return controls.models?.find((m) => m.id === modelSel.value) ?? null;
}

function renderControls(): void {
  if (!controls.connected) {
    controlsEl.hidden = true;
    return;
  }
  controlsEl.hidden = false;
  applyingControls = true;

  // Session — "New session" is the default, matching newSession() on the bridge.
  const sessions = controls.sessions ?? [];
  sessionSel.replaceChildren(
    option('', sessions.length ? 'New session' : 'New session (no history)', !controls.activeSession),
    ...sessions.map((s) =>
      option(s.session_id, `${shortPrompt(s.last_prompt)} · ${sinceLabel(s.last_run_at)}`, s.session_id === controls.activeSession),
    ),
  );
  sessionSel.disabled = !controls.project;

  // Model — grouped by vendor when the CLI reports one.
  const models = controls.models ?? [];
  modelSel.replaceChildren();
  if (models.length === 0) {
    modelSel.appendChild(option(controls.activeModel ?? '', controls.activeModel || 'no models', true));
    modelSel.disabled = true;
  } else {
    modelSel.disabled = false;
    const groups = new Map<string, ModelEntry[]>();
    for (const m of models) {
      const key = m.vendor ?? '';
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
    for (const [vendor, list] of groups) {
      const opts = list.map((m) => option(m.id, m.displayName || m.id, m.id === controls.activeModel));
      if (vendor && groups.size > 1) {
        const group = document.createElement('optgroup');
        group.label = vendor;
        group.append(...opts);
        modelSel.appendChild(group);
      } else {
        modelSel.append(...opts);
      }
    }
  }

  // Effort / fast — only for models whose CLI declares them.
  const model = selectedModel();
  const efforts = model?.efforts ?? [];
  effortWrap.hidden = efforts.length === 0;
  if (efforts.length > 0) {
    effortSel.replaceChildren(
      option('', 'CLI default', !controls.activeEffort),
      ...efforts.map((e) => option(e, e, e === controls.activeEffort)),
    );
  }
  fastWrap.hidden = model?.fast !== true;
  fastBox.checked = controls.activeFast === true;

  // Permissions — a provider with a single mode has nothing to choose.
  const modes = controls.modes ?? [];
  permWrap.hidden = modes.length < 2;
  if (modes.length > 0) {
    permSel.replaceChildren(...modes.map((m) => option(m.id, m.label, m.id === controls.activeMode)));
  }

  applyingControls = false;
}

function applyModel(): void {
  const model = selectedModel();
  if (!model) return;
  const effort = model.efforts?.length ? effortSel.value || null : null;
  vscode.postMessage({ type: 'set-model', modelId: model.id, effort, fast: model.fast === true && fastBox.checked });
}

sessionSel.addEventListener('change', () => {
  if (applyingControls) return;
  vscode.postMessage({ type: 'set-session', sessionId: sessionSel.value || null });
});
modelSel.addEventListener('change', () => {
  if (applyingControls) return;
  // A different model brings its own effort list — redraw before applying.
  const model = selectedModel();
  const efforts = model?.efforts ?? [];
  effortWrap.hidden = efforts.length === 0;
  if (efforts.length > 0) {
    applyingControls = true;
    effortSel.replaceChildren(option('', 'CLI default', true), ...efforts.map((e) => option(e, e, e === model?.defaultEffort)));
    applyingControls = false;
  }
  fastWrap.hidden = model?.fast !== true;
  applyModel();
});
effortSel.addEventListener('change', () => !applyingControls && applyModel());
fastBox.addEventListener('change', () => !applyingControls && applyModel());
permSel.addEventListener('change', () => {
  if (applyingControls) return;
  vscode.postMessage({ type: 'set-permission', id: permSel.value });
});

// ── Voice session & orb ───────────────────────────────────────────────────

/**
 * The orb, ported from the PWA's cv-voice-orb: a lit sphere whose ring and
 * bloom react to the live level. Same shape and motion, VS Code's palette.
 *
 * The mic itself lives in the extension host (src/voice.ts) — a webview has no
 * microphone permission in VS Code — so levels arrive as messages rather than
 * from an AnalyserNode here.
 */
const VIZ_BINS = 32;
const TAU = Math.PI * 2;
function orbLabel_(state: string, wakeWords: boolean, startWord: string | null): string {
  switch (state) {
    case 'off':
      return 'Tap to start';
    case 'starting':
      return 'Starting…';
    case 'listening':
      // Say which mode is running: with wake words each turn must be armed;
      // without them every utterance goes straight to the agent.
      return wakeWords ? `Listening — say "${startWord ?? 'start'}"` : 'Listening — speak, then pause';
    case 'armed':
      return 'Go ahead — say the submit word';
    case 'hearing':
      return 'Hearing you…';
    case 'transcribing':
      return 'Transcribing…';
    case 'error':
      return 'Voice error';
    default:
      return state;
  }
}

let voiceState = 'off';
/** Latest level from the host (0–1): mic while listening, output while speaking. */
let targetLevel = 0;
let displayLevel = 0;
const displayBins = new Float32Array(VIZ_BINS);
const binPhase = new Float32Array(VIZ_BINS).map(() => Math.random() * TAU);

function cssRgb(name: string, fallback: [number, number, number]): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(raw);
  if (m?.[1]) {
    const parts = m[1].split(',').map((x) => Number(x.trim()));
    if (parts.length >= 3) return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  return fallback;
}

function lighten(c: [number, number, number], amt: number): [number, number, number] {
  return [c[0] + (255 - c[0]) * amt, c[1] + (255 - c[1]) * amt, c[2] + (255 - c[2]) * amt];
}
const rgba = (c: [number, number, number], a: number): string => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
const rgbStr = (c: [number, number, number]): string => `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;

function drawOrb(): void {
  const ctx = orbCanvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = orbCanvas.clientWidth;
  const cssH = orbCanvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  if (orbCanvas.width !== cssW * dpr || orbCanvas.height !== cssH * dpr) {
    orbCanvas.width = cssW * dpr;
    orbCanvas.height = cssH * dpr;
  }
  const w = orbCanvas.width;
  const h = orbCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const baseR = Math.min(w, h) * 0.38;

  const live = voiceState === 'listening' || voiceState === 'hearing' || voiceState === 'transcribing';
  const speaking = live && displayLevel > 0.02;
  const accent = cssRgb('--vscode-textLink-foreground', [139, 92, 246]);
  const highlight = lighten(accent, 0.5);
  const mid = accent;
  const deep = [accent[0] * 0.35, accent[1] * 0.35, accent[2] * 0.35] as [number, number, number];

  ctx.clearRect(0, 0, w, h);

  const glow = speaking ? 0.35 + displayLevel * 0.65 : live ? 0.22 : 0.1;
  const bloom = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 1.35);
  bloom.addColorStop(0, rgba(accent, 0.18 * glow));
  bloom.addColorStop(0.55, rgba(mid, 0.06 * glow));
  bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, h);

  const coreR = baseR * (speaking ? 1 + displayLevel * 0.03 : 1);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, TAU);
  ctx.clip();

  const sphere = ctx.createRadialGradient(
    cx - coreR * 0.28, cy - coreR * 0.32, coreR * 0.08,
    cx + coreR * 0.1, cy + coreR * 0.12, coreR * 1.05,
  );
  sphere.addColorStop(0, rgbStr(highlight));
  sphere.addColorStop(0.45, rgbStr(mid));
  sphere.addColorStop(1, rgbStr(deep));
  ctx.fillStyle = sphere;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

  if (speaking) {
    const minR = coreR * 0.12;
    const maxR = coreR * 0.92;
    const fill = lighten(accent, 0.35);
    const ring = (): void => {
      ctx.beginPath();
      for (let i = 0; i <= VIZ_BINS; i++) {
        const bin = displayBins[i % VIZ_BINS] ?? 0;
        const radius = minR + (maxR - minR) * (0.35 + bin * 0.65);
        const angle = (i / VIZ_BINS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ring();
    ctx.fillStyle = rgba(fill, 0.1 + displayLevel * 0.18);
    ctx.fill();
    for (let r = 1; r <= 3; r++) {
      const ringR = coreR * (0.28 + (r / 4) * 0.55) + displayLevel * coreR * 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, TAU);
      ctx.strokeStyle = rgba(accent, 0.08 + displayLevel * 0.3);
      ctx.lineWidth = Math.max(1, w * 0.006);
      ctx.stroke();
    }
    ring();
    ctx.strokeStyle = rgba(lighten(accent, 0.2), 0.2 + displayLevel * 0.35);
    ctx.lineWidth = Math.max(1.5, w * 0.005);
    ctx.stroke();
  }

  const sheen = ctx.createRadialGradient(
    cx - coreR * 0.35, cy - coreR * 0.4, 0,
    cx - coreR * 0.1, cy - coreR * 0.15, coreR * 0.75,
  );
  sheen.addColorStop(0, `rgba(255, 255, 255, ${speaking ? 0.22 + displayLevel * 0.15 : 0.14})`);
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, TAU);
  ctx.strokeStyle = rgba(lighten(accent, 0.3), live ? 0.5 : 0.25);
  ctx.lineWidth = Math.max(1, w * 0.004);
  ctx.stroke();
}

function orbFrame(): void {
  requestAnimationFrame(orbFrame);
  const rise = targetLevel > displayLevel ? 0.55 : 0.22;
  displayLevel += (targetLevel - displayLevel) * rise;
  const t = performance.now() / 1000;
  for (let i = 0; i < VIZ_BINS; i++) {
    // The host sends one level, not a spectrum — spread it into bins with a
    // per-bin wobble so the ring breathes instead of pulsing as a rigid circle.
    const wobble = 0.55 + 0.45 * Math.sin(t * (1.6 + i * 0.07) + (binPhase[i] ?? 0));
    const v = displayLevel * wobble;
    displayBins[i] = (displayBins[i] ?? 0) + (v - (displayBins[i] ?? 0)) * 0.4;
  }
  drawOrb();
}
requestAnimationFrame(orbFrame);

function renderVoice(state: string, detail: string | null, wakeWords: boolean, startWord: string | null): void {
  voiceState = state;
  orbCanvas.parentElement?.setAttribute('data-state', state);
  orbLabel.textContent = detail && state === 'error' ? detail : orbLabel_(state, wakeWords, startWord);
  orbHit.title = state === 'off' ? 'Start a voice session' : 'Stop the voice session';
  if (state === 'off') targetLevel = 0;
}

orbHit.addEventListener('click', () => vscode.postMessage({ type: 'voice-toggle' }));

function openPen(open: boolean): void {
  penBox.hidden = !open;
  if (open) {
    // autoGrow measures scrollHeight, which is 0 while the dialog is hidden —
    // running it at load left the textarea one border tall.
    autoGrow();
    input.focus();
  }
}
penBtn.addEventListener('click', () => openPen(Boolean(penBox.hidden)));
penCancel.addEventListener('click', () => openPen(false));
penBox.addEventListener('click', (ev) => {
  if (ev.target === penBox) openPen(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !penBox.hidden) openPen(false);
});

// ── Host messages ─────────────────────────────────────────────────────────

window.addEventListener('message', (ev: MessageEvent<Record<string, unknown>>) => {
  const msg = ev.data;
  switch (msg['type']) {
    case 'frame':
      onFrame(msg['frame'] as DeskFrame);
      return;
    case 'status': {
      const status = String(msg['status']);
      conn.textContent = status === 'connected' ? `connected · ${String(msg['baseUrl'])}` : `${status} · ${String(msg['baseUrl'])}`;
      conn.className = `conn ${status === 'connected' ? 'ok' : status === 'connecting' ? '' : 'bad'}`;
      return;
    }
    case 'approvals':
      approvals = (msg['list'] as ApprovalRequest[]) ?? [];
      renderApprovals();
      return;
    case 'config':
      config = { readAloud: msg['readAloud'] as ReadAloud, pacer: Boolean(msg['pacer']) };
      if (config.readAloud === 'off') stopAudio();
      if (config.readAloud === 'off' && config.pacer && model.hasUnread()) model.startPacer();
      if (!config.pacer) model.stopPacer();
      return;
    case 'speech':
      onSpeech(msg as unknown as { id: string; phase: string; durationMs?: number; provider?: string | null; message?: string });
      return;
    case 'history': {
      // Replay a stored conversation on open. Everything lands read: this
      // exchange already happened, and re-speaking it on every reload would be
      // maddening. Only turns arriving live are unread.
      const turns = (msg['turns'] as { role: string; text: string; at: string }[]) ?? [];
      if (turns.length === 0 || model.snapshot().segments.length > 0) return;
      for (const t of turns) {
        if (t.role === 'user') model.addUser(t.text, t.at);
        else model.addAgent(t.text, t.at);
      }
      model.markAllRead();
      return;
    }
    case 'heard': {
      // Dim system line: shows the transcript even when it was not a command,
      // so "it didn't hear me" and "it misheard me" are distinguishable.
      // Mark ONLY this line read — markAllRead() here also marked the agent's
      // pending reply read, so it was never spoken. That was the silence.
      const note = String(msg['text']);
      const id = model.addSystem(msg['ignored'] ? `${note}  (ignored — say the start word first)` : note, 'stt');
      model.markRead(id);
      return;
    }
    case 'level':
      targetLevel = Number(msg['level']) || 0;
      return;
    case 'voice':
      renderVoice(
        String(msg['state']),
        (msg['detail'] as string | null) ?? null,
        msg['wakeWords'] !== false,
        (msg['startWord'] as string | null) ?? null,
      );
      return;
    case 'controls':
      controls = msg as unknown as Controls;
      renderControls();
      return;
    case 'markAllRead':
      stopAudio();
      model.markAllRead();
      return;
  }
});

// ── Composer ──────────────────────────────────────────────────────────────

/**
 * Match the textarea's height to its content, so it starts one line tall and
 * grows as you type. `overflow-y: hidden` plus a `max-height` in the CSS means
 * it never shows a scrollbar until it has earned one — a scrollbar (or the
 * native resize grabber) costs more width than the field can spare in a
 * sidebar this narrow.
 */
function autoGrow(): void {
  input.style.height = 'auto';
  // Everything here is `box-sizing: border-box`, but scrollHeight excludes the
  // border — assign it raw and the field ends up a border short of its content
  // and scrolls forever.
  const cs = getComputedStyle(input);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  input.style.height = `${input.scrollHeight + border}px`;
  // Past max-height the CSS clamps us, so hand scrolling back at that point.
  input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
}

function send(): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrow();
  sendBtn.disabled = true;
  thinkingEl.hidden = false;
  vscode.postMessage({ type: 'turn', text });
  openPen(false);
  // Re-enable if nothing comes back (agent not spawned, etc.).
  setTimeout(() => (sendBtn.disabled = false), 8000);
}
sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener('input', autoGrow);
$('stop').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'agentvoice.stopAgent' }));
$('markread').addEventListener('click', () => {
  stopAudio();
  model.markAllRead();
});

// Clicking an unread line marks everything up to it as read (you read it yourself).
page.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.seg');
  const id = el?.dataset['id'];
  if (!id) return;
  const segs = model.snapshot().segments;
  for (const s of segs) {
    if (s.state !== 'read') model.markRead(s.id);
    if (s.id === id) break;
  }
});

vscode.postMessage({ type: 'ready' });
