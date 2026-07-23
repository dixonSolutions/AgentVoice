import { Injectable, inject } from '@angular/core';
import { MessageService } from '@openng/optimus-ui/api';
import { LogService } from './log.service';

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly messages = inject(MessageService);
  private readonly logs = inject(LogService);

  info(summary: string, detail?: string): void {
    this.messages.add({ severity: 'info', summary, detail, life: 4000 });
    this.logs.append('info', 'system', summary, detail);
  }

  success(summary: string, detail?: string, logToPanel = true): void {
    this.messages.add({ severity: 'success', summary, detail, life: 3500 });
    if (logToPanel) this.logs.append('info', 'system', summary, detail);
  }

  warn(summary: string, detail?: string): void {
    this.messages.add({ severity: 'warn', summary, detail, life: 5000 });
    this.logs.append('warn', 'system', summary, detail);
  }

  error(summary: string, detail?: string): void {
    this.messages.add({ severity: 'error', summary, detail, life: 6000 });
    this.logs.append('error', 'system', summary, detail);
  }
}
