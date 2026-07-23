import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from '@openng/optimus-ui/button';
import { Card } from '@openng/optimus-ui/card';
import { Fluid } from '@openng/optimus-ui/fluid';
import { IftaLabel } from '@openng/optimus-ui/iftalabel';
import { Message } from '@openng/optimus-ui/message';
import { Password } from '@openng/optimus-ui/password';
import { Tag } from '@openng/optimus-ui/tag';

import { BridgeService } from '../../services/bridge.service';
import { LogService } from '../../services/log.service';
import { ToastService } from '../../services/toast.service';
import { VoiceSessionService } from '../../services/voice-session.service';

@Component({
  selector: 'cv-connection-tab',
  standalone: true,
  imports: [
    FormsModule,
    Button,
    Card,
    Fluid,
    IftaLabel,
    Message,
    Password,
    Tag,
  ],
  templateUrl: './connection-tab.component.html',
})
export class ConnectionTabComponent implements OnInit {
  protected readonly bridge = inject(BridgeService);
  private readonly voiceSession = inject(VoiceSessionService);
  private readonly toast = inject(ToastService);
  private readonly logs = inject(LogService);

  protected tokenInput = '';

  ngOnInit(): void {}

  protected wsStatusLabel(): string {
    switch (this.bridge.wsStatus()) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting…';
      case 'error':
        return 'Reconnecting…';
      default:
        return 'Disconnected';
    }
  }

  protected wsStatusSeverity(): 'success' | 'warn' | 'secondary' {
    const ws = this.bridge.wsStatus();
    if (ws === 'connected') return 'success';
    if (ws === 'error' || ws === 'connecting') return 'warn';
    return 'secondary';
  }

  protected onSaveCredentials(): void {
    const token = this.tokenInput.trim();
    if (!token) {
      this.toast.warn('App token required', 'Paste the token from your bridge .env file.');
      return;
    }
    this.bridge.saveCredentials(token);
    this.tokenInput = '';
    this.bridge.connect();
    this.logs.append('info', 'bridge', 'Credentials updated');
    this.toast.success('Saved', 'Connecting to bridge…');
  }

  protected onConnect(): void {
    this.bridge.connect();
    this.logs.append('info', 'bridge', 'Connect requested');
    this.toast.info('Connecting…');
  }

  protected onDisconnect(): void {
    this.voiceSession.stopSession();
    this.bridge.disconnect();
    this.logs.append('info', 'bridge', 'Disconnected from bridge');
    this.toast.info('Disconnected from bridge');
  }

  protected onClearAppCredentials(): void {
    if (!confirm('Clear saved app token?')) return;
    this.voiceSession.stopSession();
    this.bridge.clearCredentials();
    this.tokenInput = '';
    this.logs.append('warn', 'bridge', 'App credentials cleared');
  }
}
