import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Message } from 'primeng/message';
import { ScrollPanel } from 'primeng/scrollpanel';
import { SelectButton } from 'primeng/selectbutton';
import { Tag } from 'primeng/tag';

import type { LogCategory, LogEntry, LogLevel } from '../../services/log.service';
import { LogService } from '../../services/log.service';
import { ToastService } from '../../services/toast.service';

type LogFilter = 'all' | 'transcript' | 'debug' | 'errors';

@Component({
  selector: 'cv-logs-tab',
  standalone: true,
  imports: [
    FormsModule,
    Button,
    Card,
    Message,
    ScrollPanel,
    SelectButton,
    Tag,
  ],
  templateUrl: './logs-tab.component.html',
})
export class LogsTabComponent {
  protected readonly logs = inject(LogService);
  private readonly toast = inject(ToastService);

  protected filter: LogFilter = 'all';

  protected readonly filterOptions = [
    { label: 'All', value: 'all' as const },
    { label: 'Transcript', value: 'transcript' as const },
    { label: 'Debug', value: 'debug' as const },
    { label: 'Errors', value: 'errors' as const },
  ];

  protected readonly filteredEntries = computed(() => {
    const entries = this.logs.entries();
    switch (this.filter) {
      case 'transcript':
        return entries.filter((e) => e.category === 'transcript');
      case 'debug':
        return entries.filter((e) => e.level === 'debug' || e.level === 'info');
      case 'errors':
        return entries.filter((e) => e.level === 'error' || e.level === 'warn');
      default:
        return entries;
    }
  });

  protected tagSeverity(level: LogLevel): 'secondary' | 'info' | 'warn' | 'danger' {
    switch (level) {
      case 'error':
        return 'danger';
      case 'warn':
        return 'warn';
      case 'debug':
        return 'secondary';
      default:
        return 'info';
    }
  }

  protected messageSeverity(level: LogLevel): 'secondary' | 'info' | 'warn' | 'error' {
    switch (level) {
      case 'error':
        return 'error';
      case 'warn':
        return 'warn';
      case 'debug':
        return 'secondary';
      default:
        return 'info';
    }
  }

  protected categoryLabel(category: LogCategory): string {
    switch (category) {
      case 'transcript':
        return 'Transcript';
      case 'voice':
        return 'Voice';
      case 'bridge':
        return 'Bridge';
      default:
        return 'System';
    }
  }

  protected formatTime(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  protected clearLogs(): void {
    this.logs.clear();
  }

  protected async copyAllLogs(): Promise<void> {
    const entries = this.filteredEntries();
    const text = this.logs.formatLogText(entries);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied all logs', undefined, false);
    } catch {
      this.toast.error('Copy failed', 'Could not access clipboard.');
    }
  }

  protected exportLogsJson(): void {
    const entries = this.filteredEntries();
    if (entries.length === 0) return;
    const blob = new Blob([this.logs.exportLogJson(entries, 'all')], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cursor-voice-logs-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toast.success('Exported JSON', undefined, false);
  }
}
