import { Injectable, inject, signal } from '@angular/core';
import { BridgeService } from './bridge.service';
import type {
  VoiceSettingsResponse,
  WakeSensitivity,
} from '../models/voice-providers';

/**
 * Voice settings — wake words and turn-submit timing via /api/voice/*.
 */
@Injectable({ providedIn: 'root' })
export class VoiceProvidersService {
  private readonly bridge = inject(BridgeService);

  readonly data = signal<VoiceSettingsResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.apiFetch<VoiceSettingsResponse>('/api/voice/providers');
      this.data.set(res);
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async updateWakeWords(
    start: string,
    end?: string,
    silenceMs?: number,
    vadEnabled?: boolean,
    cancel?: string,
    sensitivity?: WakeSensitivity,
  ): Promise<void> {
    await this.mutate('/api/voice/wake-words', {
      method: 'PATCH',
      body: JSON.stringify({
        start,
        ...(end !== undefined ? { end } : {}),
        ...(silenceMs !== undefined ? { silenceMs } : {}),
        ...(vadEnabled !== undefined ? { vadEnabled } : {}),
        ...(cancel !== undefined ? { cancel } : {}),
        ...(sensitivity !== undefined ? { sensitivity } : {}),
      }),
    });
  }

  async updateUserName(userName: string | null): Promise<void> {
    await this.mutate('/api/voice/user-name', {
      method: 'PATCH',
      body: JSON.stringify({ userName }),
    });
  }

  async updateVoiceTts(tts: Partial<VoiceSettingsResponse['tts']>): Promise<void> {
    await this.mutate('/api/voice/tts', {
      method: 'PATCH',
      body: JSON.stringify(tts),
    });
  }

  private async mutate(path: string, opts: RequestInit): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.apiFetch<VoiceSettingsResponse>(path, opts);
      this.data.set(res);
    } catch (err) {
      this.error.set(String(err));
      throw err;
    } finally {
      this.loading.set(false);
    }
  }
}
