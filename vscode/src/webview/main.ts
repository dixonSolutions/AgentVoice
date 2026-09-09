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
  type ReadAlongSnapshot,
  type Segment,
} from '@agentvoice/client';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const page = $('#page'.slice(1));
const conn = $('conn');
const meta = $('meta');
const bar = $('bar');
const approvalsEl = $('approvals');
const activityEl = $('activity');
const activityList = $('activity-list');
const thinkingEl = $('thinking');
const input = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const audioState = $('audio-state');

type ReadAloud = 'off' | 'bridge' | 'browser';
let config: { readAloud: ReadAloud; pacer: boolean } = { readAloud: 'off', pacer: true };
let state: DeskState | null = null;
let approvals: ApprovalRequest[] = [];
const model = new ReadAlongModel({ wpm: 185 });
const rendered = new Map<string, HTMLElement>();

// ── Rendering ─────────────────────────────────────────────────────────────

function renderSegment(seg: Segment, el: HTMLElement): void {
  el.className = `seg ${seg.role} ${seg.state}`;
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

model.subscribe(render);

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

function addActivity(kind: string, text: string, opts: { cls?: string; path?: string } = {}): void {
  activityEl.hidden = false;
  const li = document.createElement('li');
  li.className = opts.cls ?? '';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = kind;
  li.append(k);
  if (opts.path) {
    const a = document.createElement('a');
    a.textContent = text;
    a.title = opts.path;
    a.addEventListener('click', () => vscode.postMessage({ type: 'open', path: opts.path }));
    li.append(a);
  } else {
    li.append(document.createTextNode(text));
  }
  activityList.append(li);
  while (activityList.children.length > 200) activityList.firstElementChild?.remove();
  li.scrollIntoView({ block: 'nearest' });
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

let audio: HTMLAudioElement | null = null;
let speakingSeg: string | null = null;
const pendingTts = new Map<string, string>();
let ttsSeq = 0;

function stopAudio(): void {
  if (audio) {
    audio.pause();
    audio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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
    vscode.postMessage({ type: 'tts', id, text: seg.text });
    return;
  }
  // Silent — let the pacer own it.
  speakingSeg = null;
  if (config.pacer) model.startPacer();
}

function playTts(msg: { id: string; audio?: string; contentType?: string; provider?: string | null; error?: string }): void {
  const segId = pendingTts.get(msg.id);
  pendingTts.delete(msg.id);
  if (!segId) return;
  if (msg.error || !msg.audio) {
    audioState.textContent = `bridge speech unavailable: ${msg.error ?? 'no audio'}`;
    speakingSeg = null;
    config = { ...config, readAloud: 'off' };
    if (config.pacer) model.startPacer();
    return;
  }
  const bytes = Uint8Array.from(atob(msg.audio), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: msg.contentType ?? 'audio/mpeg' }));
  const el = new Audio(url);
  audio = el;
  const seg = model.snapshot().segments.find((s) => s.id === segId);
  const words = seg?.words.length ?? 1;
  el.addEventListener('timeupdate', () => {
    if (!el.duration || !Number.isFinite(el.duration)) return;
    model.advance({ wordIndex: Math.floor((el.currentTime / el.duration) * words) });
  });
  const finish = (): void => {
    URL.revokeObjectURL(url);
    model.markRead(segId);
    if (audio === el) audio = null;
    speakingSeg = null;
    readNext();
  };
  el.addEventListener('ended', finish);
  el.addEventListener('error', () => {
    audioState.textContent = 'audio playback failed';
    finish();
  });
  audioState.textContent = `speaking (${msg.provider ?? 'bridge'})`;
  void el.play().catch((err: unknown) => {
    audioState.textContent = `playback blocked: ${String(err)}`;
    finish();
  });
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
    case 'tts':
      playTts(msg as { id: string; audio?: string; contentType?: string; provider?: string | null; error?: string });
      return;
    case 'markAllRead':
      stopAudio();
      model.markAllRead();
      return;
  }
});

// ── Composer ──────────────────────────────────────────────────────────────

function send(): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;
  thinkingEl.hidden = false;
  vscode.postMessage({ type: 'turn', text });
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
$('stop').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'agentvoice.stopAgent' }));
$('read').addEventListener('click', () => {
  if (config.readAloud === 'off') {
    // One-shot: use the editor voice if it exists, else just pace.
    config = { ...config, readAloud: 'speechSynthesis' in window && window.speechSynthesis.getVoices().length > 0 ? 'browser' : 'off' };
  }
  model.stopPacer();
  readNext();
});
$('markread').addEventListener('click', () => {
  stopAudio();
  model.markAllRead();
});
$('activity-clear').addEventListener('click', () => {
  activityList.replaceChildren();
  activityEl.hidden = true;
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
