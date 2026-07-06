import { Injectable, signal } from '@angular/core';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory = 'transcript' | 'voice' | 'bridge' | 'system';
export type VoiceLogSubcategory = 'stt' | 'tts' | 'tool' | 'pipeline';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  category: LogCategory;
  subcategory?: VoiceLogSubcategory;
  summary: string;
  detail?: string;
}

const MAX_ENTRIES = 200;
let _nextId = 0;

@Injectable({ providedIn: 'root' })
export class LogService {
  readonly entries = signal<LogEntry[]>([]);

  append(
    level: LogLevel,
    category: LogCategory,
    summary: string,
    detail?: string,
    subcategory?: VoiceLogSubcategory,
  ): void {
    const entry: LogEntry = {
      id: _nextId++,
      at: Date.now(),
      level,
      category,
      summary,
      detail,
      subcategory,
    };
    this.entries.update((list) => {
      const next = [...list, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }

  voiceLog(
    subcategory: VoiceLogSubcategory,
    level: LogLevel,
    summary: string,
    detail?: string,
  ): void {
    this.append(level, 'voice', summary, detail, subcategory);
  }

  transcript(role: 'user' | 'assistant', text: string): void {
    this.append(
      'info',
      'transcript',
      role === 'user' ? `You: ${text}` : text,
    );
  }

  clear(): void {
    this.entries.set([]);
  }

  /** Clear voice/transcript lines from the live session panel only. */
  clearVoiceSession(): void {
    this.entries.update((list) =>
      list.filter((e) => e.category !== 'voice' && e.category !== 'transcript'),
    );
  }

  /** Replace voice session lines with persisted history from the server. */
  loadSessionHistory(
    entries: Array<{ at: string; level: LogLevel; summary: string; detail?: string }>,
  ): void {
    this.clearVoiceSession();
    if (entries.length === 0) return;

    const historical: LogEntry[] = entries.map((entry) => ({
      id: _nextId++,
      at: Date.parse(entry.at) || Date.now(),
      level: entry.level,
      category: 'voice',
      summary: entry.summary,
      detail: entry.detail,
    }));

    this.entries.update((list) => {
      const merged = [...list, ...historical];
      return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
    });
  }

  /** Full single-line text for clipboard copy. */
  formatEntryLine(entry: LogEntry): string {
    const tag = entry.subcategory ?? entry.category;
    const detail = entry.detail ? ` — ${entry.detail}` : '';
    return `${new Date(entry.at).toLocaleTimeString()} [${tag}] ${entry.summary}${detail}`;
  }

  /** Voice + transcript lines for the live session panel. */
  sessionEntries(): LogEntry[] {
    return this.entries().filter(
      (e) => e.category === 'voice' || e.category === 'transcript',
    );
  }

  formatSessionLogText(entries = this.sessionEntries()): string {
    return this.formatLogText(entries);
  }

  formatLogText(entries: LogEntry[]): string {
    return entries.map((e) => this.formatEntryLine(e)).join('\n');
  }

  exportSessionLogJson(entries = this.sessionEntries()): string {
    return this.exportLogJson(entries, 'session');
  }

  exportLogJson(entries: LogEntry[], scope: 'session' | 'all' = 'all'): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        scope,
        count: entries.length,
        entries: entries.map((e) => ({
          at: new Date(e.at).toISOString(),
          level: e.level,
          category: e.category,
          subcategory: e.subcategory ?? null,
          summary: e.summary,
          detail: e.detail ?? null,
        })),
      },
      null,
      2,
    );
  }
}
