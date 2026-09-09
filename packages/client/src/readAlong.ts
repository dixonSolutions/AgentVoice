/**
 * Read-along transcript model.
 *
 * The agent's spoken lines (`speak` frames) arrive one sentence at a time.
 * A desk client shows them as a page of text: what has already been read is
 * bright, what is still ahead is dimmed, and the segment being read now is
 * highlighted word by word. "Read" can be driven by real audio (phone TTS,
 * bridge TTS in a webview, browser speechSynthesis boundary events) or by a
 * silent pacing timer when nothing is playing — the model does not care.
 *
 * Pure TypeScript, no DOM: the PWA and the extension webview both render it.
 */

export type SegmentState = 'unread' | 'reading' | 'read';

export type SegmentRole = 'agent' | 'user' | 'narration' | 'system';

export interface Segment {
  id: string;
  role: SegmentRole;
  text: string;
  words: string[];
  state: SegmentState;
  /** Index of the next unread word while `reading` (0..words.length). */
  wordIndex: number;
  ts: string;
  /** Free-form tag, e.g. narration kind or tool activity label. */
  kind?: string;
}

export interface ReadAlongSnapshot {
  segments: Segment[];
  /** Id of the segment being read, if any. */
  readingId: string | null;
  /** 0..1 progress across all agent words. */
  progress: number;
}

export interface PacingOptions {
  /** Words per minute for the silent pacer (default 190). */
  wpm?: number;
  /** Minimum ms per word (default 120). */
  minWordMs?: number;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `seg-${Date.now().toString(36)}-${seq}`;
}

export function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export class ReadAlongModel {
  private segments: Segment[] = [];
  private readingId: string | null = null;
  private readonly listeners = new Set<(snap: ReadAlongSnapshot) => void>();
  private pacer: ReturnType<typeof setTimeout> | null = null;
  private readonly pacing: Required<PacingOptions>;
  /** Max segments kept in memory. */
  private readonly maxSegments: number;

  constructor(opts: PacingOptions & { maxSegments?: number } = {}) {
    this.pacing = { wpm: opts.wpm ?? 190, minWordMs: opts.minWordMs ?? 120 };
    this.maxSegments = opts.maxSegments ?? 400;
  }

  subscribe(fn: (snap: ReadAlongSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): ReadAlongSnapshot {
    const agentWords = this.segments.filter((s) => s.role === 'agent');
    const total = agentWords.reduce((n, s) => n + s.words.length, 0);
    const done = agentWords.reduce(
      (n, s) => n + (s.state === 'read' ? s.words.length : s.state === 'reading' ? s.wordIndex : 0),
      0,
    );
    return {
      segments: [...this.segments],
      readingId: this.readingId,
      progress: total === 0 ? 0 : done / total,
    };
  }

  /** Append an agent line (from `speak`). Returns the segment id. */
  addAgent(text: string, ts = new Date().toISOString()): string {
    return this.add('agent', text, ts);
  }

  /** Append something the user said or typed — shown bright immediately. */
  addUser(text: string, ts = new Date().toISOString()): string {
    const id = this.add('user', text, ts);
    this.markRead(id);
    return id;
  }

  addNarration(text: string, kind?: string, ts = new Date().toISOString()): string {
    return this.add('narration', text, ts, kind);
  }

  addSystem(text: string, kind?: string, ts = new Date().toISOString()): string {
    const id = this.add('system', text, ts, kind);
    this.markRead(id);
    return id;
  }

  /** Start reading a segment (by id, or the first unread agent segment). */
  startReading(id?: string): Segment | null {
    const target = id ? this.find(id) : this.firstUnread();
    if (!target) return null;
    if (this.readingId && this.readingId !== target.id) this.markRead(this.readingId);
    target.state = 'reading';
    target.wordIndex = 0;
    this.readingId = target.id;
    this.emit();
    return target;
  }

  /** Word-level progress for the reading segment (charIndex from a TTS boundary event, or a word index). */
  advance(opts: { wordIndex?: number; charIndex?: number }): void {
    const seg = this.readingId ? this.find(this.readingId) : null;
    if (!seg) return;
    let idx = seg.wordIndex;
    if (typeof opts.wordIndex === 'number') idx = opts.wordIndex;
    else if (typeof opts.charIndex === 'number') idx = wordIndexAtChar(seg.text, opts.charIndex);
    seg.wordIndex = Math.max(0, Math.min(seg.words.length, idx));
    this.emit();
  }

  /** Whole segment finished. */
  markRead(id?: string): void {
    const seg = id ? this.find(id) : this.readingId ? this.find(this.readingId) : null;
    if (!seg) return;
    seg.state = 'read';
    seg.wordIndex = seg.words.length;
    if (this.readingId === seg.id) this.readingId = null;
    this.emit();
  }

  /** Everything up to and including `id` (or all) becomes read. */
  markAllRead(): void {
    for (const seg of this.segments) {
      seg.state = 'read';
      seg.wordIndex = seg.words.length;
    }
    this.readingId = null;
    this.stopPacer();
    this.emit();
  }

  hasUnread(): boolean {
    return this.segments.some((s) => s.state === 'unread' && (s.role === 'agent' || s.role === 'narration'));
  }

  /**
   * Silent pacer: reads unread agent segments at reading speed so the page
   * brightens as a human would follow it. Idempotent; stops when nothing is
   * left. Call `stopPacer()` when real audio takes over.
   */
  startPacer(): void {
    if (this.pacer) return;
    const step = (): void => {
      this.pacer = null;
      let seg = this.readingId ? this.find(this.readingId) : null;
      if (!seg || seg.state !== 'reading') seg = this.startReading() ?? null;
      if (!seg) return;
      if (seg.wordIndex >= seg.words.length) {
        this.markRead(seg.id);
        this.pacer = setTimeout(step, 250);
        return;
      }
      const word = seg.words[seg.wordIndex] ?? '';
      this.advance({ wordIndex: seg.wordIndex + 1 });
      const perWord = 60_000 / this.pacing.wpm;
      const punctuationPause = /[.!?;:]$/.test(word) ? 260 : /,$/.test(word) ? 120 : 0;
      const ms = Math.max(this.pacing.minWordMs, perWord + word.length * 8) + punctuationPause;
      this.pacer = setTimeout(step, ms);
    };
    step();
  }

  stopPacer(): void {
    if (this.pacer) {
      clearTimeout(this.pacer);
      this.pacer = null;
    }
  }

  clear(): void {
    this.stopPacer();
    this.segments = [];
    this.readingId = null;
    this.emit();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private add(role: SegmentRole, text: string, ts: string, kind?: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    const seg: Segment = {
      id: nextId(),
      role,
      text: clean,
      words: splitWords(clean),
      state: 'unread',
      wordIndex: 0,
      ts,
      ...(kind ? { kind } : {}),
    };
    this.segments.push(seg);
    if (this.segments.length > this.maxSegments) {
      this.segments.splice(0, this.segments.length - this.maxSegments);
    }
    this.emit();
    return seg.id;
  }

  private find(id: string): Segment | null {
    return this.segments.find((s) => s.id === id) ?? null;
  }

  private firstUnread(): Segment | null {
    return this.segments.find((s) => s.state === 'unread' && (s.role === 'agent' || s.role === 'narration')) ?? null;
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

/** Index of the word containing character `charIndex` of `text`. */
export function wordIndexAtChar(text: string, charIndex: number): number {
  let idx = 0;
  let inWord = false;
  for (let i = 0; i < text.length && i <= charIndex; i += 1) {
    const ws = /\s/.test(text[i] ?? '');
    if (!ws && !inWord) {
      inWord = true;
      if (i <= charIndex) idx += 1;
    } else if (ws) {
      inWord = false;
    }
  }
  return Math.max(0, idx - 1);
}
