/**
 * Config → Speech — one screen for both directions.
 *
 * Everything here is driven by `GET /api/speech`: the provider cards, their
 * models, voices, languages and scopes all come from the bridge, so adding a
 * provider or an option needs no change in this component. The only
 * device-specific part is the browser voice picker, which reads
 * speechSynthesis directly because only this device knows what it has.
 *
 * See docs/30-provider-scopes-and-speech-output.md.
 */

import type { OnDestroy, OnInit } from '@angular/core';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';

import { Button } from '@openng/optimus-ui/button';
import { Divider } from '@openng/optimus-ui/divider';
import { Fieldset } from '@openng/optimus-ui/fieldset';
import { Fluid } from '@openng/optimus-ui/fluid';
import { IftaLabel } from '@openng/optimus-ui/iftalabel';
import { InputNumber } from '@openng/optimus-ui/inputnumber';
import { InputText } from '@openng/optimus-ui/inputtext';
import { Message } from '@openng/optimus-ui/message';
import { MultiSelect } from '@openng/optimus-ui/multiselect';
import { Password } from '@openng/optimus-ui/password';
import { PrimeTemplate } from '@openng/optimus-ui/api';
import { ProgressSpinner } from '@openng/optimus-ui/progressspinner';
import { Select } from '@openng/optimus-ui/select';
import type { SelectLazyLoadEvent } from '@openng/optimus-ui/types/select';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '@openng/optimus-ui/tabs';
import { Tag } from '@openng/optimus-ui/tag';
import { ToggleSwitch } from '@openng/optimus-ui/toggleswitch';

import {
  currentBrowserProfileId,
  deleteBrowserTtsProfile,
  detectBrowserLabel,
  curateBrowserTtsVoices,
  listBrowserTtsProfiles,
  listBrowserTtsVoicesAsync,
  onBrowserTtsVoicesChanged,
  saveBrowserTtsProfile,
  browserVoiceLanguages,
  type BrowserTtsProfile,
} from '../../../browser-tts-settings.js';
import { AdminService } from '../../services/admin.service';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import type {
  ProviderScope,
  ScopeValue,
  SpeechInputProviderId,
  SpeechInputProviderInfo,
  SpeechInputTestResult,
  SpeechOutputProviderId,
  SpeechOutputProviderInfo,
  SpeechServerSettings,
  SpeechServerStatus,
  SpeechView,
  SpeechVoiceOption,
} from '../../models/speech';

type Direction = 'stt' | 'tts';
type BrowserVoiceOption = { label: string; value: string; disabled?: boolean };

const BROWSER_VOICE_LAZY_CHUNK = 64;
const BROWSER_VOICE_CURATED_MAX = 80;

@Component({
  selector: 'cv-speech-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet, FormsModule, Button, Divider, Fieldset, Fluid, IftaLabel, InputNumber, InputText,
    Message, MultiSelect, Password, PrimeTemplate, ProgressSpinner, Select,
    Tabs, TabList, Tab, TabPanels, TabPanel, Tag, ToggleSwitch,
  ],
  templateUrl: './speech-tab.component.html',
})
export class SpeechTabComponent implements OnInit, OnDestroy {
  private readonly admin = inject(AdminService);
  private readonly bridge = inject(BridgeService);
  private readonly toast = inject(ToastService);
  private readonly voiceSession = inject(VoiceSessionService);
  private readonly cdr = inject(ChangeDetectorRef);

  protected readonly view = signal<SpeechView | null>(null);
  protected readonly loading = signal(false);
  protected readonly direction = signal<Direction>('stt');

  protected onDirectionChange(next: Direction): void {
    this.direction.set(next);
    // Key input and results are per-provider; carrying them across is misleading.
    this.keyInput = '';
    this.sttTestResult = null;
    this.ttsPreviewError = null;
  }

  protected readonly isBridgeConnected = computed(() => this.bridge.wsStatus() === 'connected');
  /** HTTP works with stored credentials — the WebSocket is not required to load. */
  private readonly canUseApi = computed(() => this.bridge.hasCredentials());

  // Which provider card is expanded. Defaults to the active one on load.
  protected selectedStt: SpeechInputProviderId = 'browser';
  protected selectedTts: SpeechOutputProviderId = 'browser';

  protected keyInput = '';
  protected savingKey = false;
  protected saving = false;
  protected testing = false;
  protected sttTestResult: SpeechInputTestResult | null = null;
  protected ttsPreviewError: string | null = null;
  protected previewing = false;

  /** Live voice catalogs, keyed by `${provider}:${model}`. */
  private readonly voiceCatalog = new Map<string, SpeechVoiceOption[]>();
  protected loadingVoices = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    void this.reload();
    this.unsubBrowserVoices = onBrowserTtsVoicesChanged((voices) =>
      this.applyBrowserVoiceOptions(voices),
    );
  }

  ngOnDestroy(): void {
    if (this.browserVoiceSearchTimer) clearTimeout(this.browserVoiceSearchTimer);
    this.unsubBrowserVoices?.();
    if (this.setupPollTimer) clearTimeout(this.setupPollTimer);
    this.setupProgressSub?.unsubscribe();
    this.previewRevoke?.();
  }

  protected async reload(): Promise<void> {
    if (!this.canUseApi()) return;
    this.loading.set(true);
    try {
      const view = await this.admin.getSpeech();
      this.applyView(view);
      await this.loadBrowserVoices();
      if (this.needsServerPanel) await this.loadServerStatus();
    } catch (err) {
      this.toast.error('Could not load speech settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
      this.cdr.markForCheck();
    }
  }

  private applyView(view: SpeechView): void {
    this.view.set(view);
    // Don't yank a card the user is editing out from under them.
    if (!this.saving) {
      this.selectedStt = view.stt.provider;
      this.selectedTts = view.tts.provider;
    }
    this.cdr.markForCheck();
  }

  // ── Provider cards ───────────────────────────────────────────────────────

  protected get sttProviders(): SpeechInputProviderInfo[] {
    return this.view()?.stt.providers ?? [];
  }

  protected get ttsProviders(): SpeechOutputProviderInfo[] {
    return this.view()?.tts.providers ?? [];
  }

  protected get sttProvider(): SpeechInputProviderInfo | null {
    return this.sttProviders.find((p) => p.id === this.selectedStt) ?? null;
  }

  protected get ttsProvider(): SpeechOutputProviderInfo | null {
    return this.ttsProviders.find((p) => p.id === this.selectedTts) ?? null;
  }

  protected get provider(): SpeechInputProviderInfo | SpeechOutputProviderInfo | null {
    return this.direction() === 'stt' ? this.sttProvider : this.ttsProvider;
  }

  protected statusLabel(p: { available: boolean; configured: boolean; capabilities: { apiKeyEnvVar: string | null } }): string {
    if (p.available) return 'Ready';
    if (p.configured) return 'Needs setup';
    return p.capabilities.apiKeyEnvVar ? 'No key' : 'Not running';
  }

  protected statusSeverity(p: { available: boolean; configured: boolean }): 'success' | 'warn' | 'secondary' {
    if (p.available) return 'success';
    return p.configured ? 'warn' : 'secondary';
  }

  protected sttCost(p: SpeechInputProviderInfo): string {
    const cost = p.capabilities.approxUsdPerAudioHour;
    return cost === null ? 'No per-minute cost' : `~$${cost.toFixed(2)} / audio hour`;
  }

  protected ttsCost(p: SpeechOutputProviderInfo): string {
    const cost = p.capabilities.approxUsdPerMillionChars;
    return cost === null ? 'No per-character cost' : `~$${cost} / million characters`;
  }

  /**
   * The selected voice cannot speak the reply language, but another voice from
   * the same provider can. Worth saying, because the swap happens silently.
   */
  protected get voiceLanguageHint(): string | null {
    const view = this.view();
    const p = this.ttsProvider;
    if (!view || !p || p.id === 'browser') return null;
    const language = view.tts.effectiveLanguage;
    if (!language || language === 'auto') return null;
    if (p.voiceLanguages.length === 0 || p.voiceLanguages.includes(language)) return null;
    if (!p.languages.includes(language)) return null;
    return `"${p.selectedVoice}" does not speak ${language} — ${p.displayName} will use one of its other voices for those replies.`;
  }

  protected onSelectStt(id: SpeechInputProviderId): void {
    this.selectedStt = id;
    this.keyInput = '';
    this.sttTestResult = null;
    if (id === 'local_whisper') void this.loadServerStatus();
  }

  protected onSelectTts(id: SpeechOutputProviderId): void {
    this.selectedTts = id;
    this.keyInput = '';
    this.ttsPreviewError = null;
    if (id === 'local_speech') void this.loadServerStatus();
    else if (id !== 'browser') void this.loadVoiceCatalog(id);
  }

  /** Fallback options exclude the primary — a provider cannot follow itself. */
  protected get sttFallbackOptions(): Array<{ label: string; value: string }> {
    const view = this.view();
    if (!view) return [];
    return this.sttProviders
      .filter((p) => p.id !== view.stt.provider)
      .map((p) => ({ label: `${p.displayName} — ${this.statusLabel(p)}`, value: p.id }));
  }

  protected get ttsFallbackOptions(): Array<{ label: string; value: string }> {
    const view = this.view();
    if (!view) return [];
    return this.ttsProviders
      .filter((p) => p.id !== view.tts.provider)
      .map((p) => ({ label: `${p.displayName} — ${this.statusLabel(p)}`, value: p.id }));
  }

  protected get languageOptions(): Array<{ label: string; value: string }> {
    const langs = this.view()?.languages ?? [];
    return [
      { label: 'Auto-detect', value: 'auto' },
      ...langs.map((l) => ({
        label: l.name === l.nativeName ? l.name : `${l.name} (${l.nativeName})`,
        value: l.code,
      })),
    ];
  }

  /**
   * Providers in the current chain that cannot handle the selected language.
   * Surfacing this is the whole point of tracking per-provider language
   * support — an unsupported pick is visible before it fails, not after.
   */
  protected get languageGaps(): string[] {
    const view = this.view();
    if (!view) return [];
    const dir = this.direction();
    const language = dir === 'stt' ? view.stt.language : view.tts.effectiveLanguage;
    if (!language || language === 'auto') return [];

    const chain = dir === 'stt' ? view.stt.chain : view.tts.chain;
    const providers: Array<{ id: string; displayName: string; languages: string[] }> =
      dir === 'stt' ? view.stt.providers : view.tts.providers;

    return chain
      .filter((id) => {
        const p = providers.find((x) => x.id === id);
        // The browser card reports no catalog — the device answers that itself.
        return p && p.id !== 'browser' && p.languages.length > 0 && !p.languages.includes(language);
      })
      .map((id) => providers.find((x) => x.id === id)?.displayName ?? id);
  }

  // ── Scopes ───────────────────────────────────────────────────────────────

  protected scopeValue(scope: ProviderScope): ScopeValue {
    return this.provider?.scopeValues[scope.id] ?? scope.default;
  }

  protected setScopeValue(scope: ProviderScope, value: ScopeValue): void {
    const provider = this.provider;
    if (!provider) return;
    provider.scopeValues = { ...provider.scopeValues, [scope.id]: value };
    this.cdr.markForCheck();
  }

  protected get basicScopes(): ProviderScope[] {
    return (this.provider?.scopes ?? []).filter((s) => !s.advanced);
  }

  protected get advancedScopes(): ProviderScope[] {
    return (this.provider?.scopes ?? []).filter((s) => s.advanced);
  }

  protected showAdvanced = false;

  protected scopeChoices(scope: ProviderScope): Array<{ label: string; value: ScopeValue }> {
    return (scope.choices ?? []).map((c) => ({
      label: c.note ? `${c.label} — ${c.note}` : c.label,
      value: c.value,
    }));
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  protected async onSaveStt(): Promise<void> {
    const view = this.view();
    const provider = this.sttProvider;
    if (!view || !provider) return;

    this.saving = true;
    try {
      const res = await this.admin.patchSpeechInput({
        provider: this.selectedStt,
        language: view.stt.language,
        fallbacks: view.stt.fallbacks,
        ...(provider.id === 'browser'
          ? {}
          : { model: provider.selectedModel, scopes: provider.scopeValues, scopeProvider: provider.id }),
      });
      this.saving = false;
      this.applyView(res);
      this.toast.success(
        'Speech input saved',
        this.voiceSession.conversationActive()
          ? 'Restart the voice session to use the new engine.'
          : this.describeChain(res.stt.chain, res.stt.providers),
      );
    } catch (err) {
      this.toast.error('Could not save speech input', err instanceof Error ? err.message : String(err));
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  protected async onSaveTts(): Promise<void> {
    const view = this.view();
    const provider = this.ttsProvider;
    if (!view || !provider) return;

    this.saving = true;
    try {
      if (provider.id === 'browser') this.saveBrowserProfile();

      const res = await this.admin.patchSpeechOutput({
        provider: this.selectedTts,
        language: view.tts.language,
        fallbacks: view.tts.fallbacks,
        ...(provider.id === 'browser'
          ? {}
          : {
              model: provider.selectedModel,
              voice: provider.selectedVoice,
              scopes: provider.scopeValues,
              scopeProvider: provider.id,
            }),
      });
      this.saving = false;
      this.applyView(res);
      this.toast.success(
        'Speech output saved',
        this.voiceSession.conversationActive()
          ? 'Restart the voice session to use the new voice.'
          : this.describeChain(res.tts.chain, res.tts.providers),
      );
    } catch (err) {
      this.toast.error('Could not save speech output', err instanceof Error ? err.message : String(err));
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  private describeChain(chain: string[], providers: Array<{ id: string; displayName: string }>): string {
    return chain.map((id) => providers.find((p) => p.id === id)?.displayName ?? id).join(' → ');
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  /** AWS keys stay on the Bedrock screen — they grant more than speech. */
  protected get keyEnvVar(): string | null {
    const envVar = this.provider?.capabilities.apiKeyEnvVar ?? null;
    return envVar && !envVar.startsWith('AWS_') ? envVar : null;
  }

  protected async onSaveKey(): Promise<void> {
    const envVar = this.keyEnvVar;
    const value = this.keyInput.trim();
    if (!envVar || !value) {
      this.toast.warn('Nothing to save', 'Paste the API key first.');
      return;
    }
    await this.writeKey(envVar, value, `${envVar} written to .env on the bridge.`);
  }

  protected async onClearKey(): Promise<void> {
    const envVar = this.keyEnvVar;
    if (!envVar) return;
    await this.writeKey(envVar, '', `${envVar} cleared from .env.`);
  }

  private async writeKey(envVar: string, value: string, detail: string): Promise<void> {
    this.savingKey = true;
    try {
      const res = await this.admin.patchSpeechKeys({ [envVar]: value });
      this.applyView(res);
      this.keyInput = '';
      this.sttTestResult = null;
      this.toast.success(value ? 'Key saved' : 'Key removed', detail);
    } catch (err) {
      this.toast.error('Could not update key', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingKey = false;
      this.cdr.markForCheck();
    }
  }

  // ── Test / preview ───────────────────────────────────────────────────────

  protected async onTestStt(): Promise<void> {
    const provider = this.sttProvider;
    if (!provider) return;
    this.testing = true;
    this.sttTestResult = null;
    try {
      this.sttTestResult = await this.admin.testSpeechInput(provider.id, provider.selectedModel);
      if (this.sttTestResult.ok) {
        this.toast.success(
          'Provider reachable',
          this.sttTestResult.note ?? `${this.sttTestResult.model} answered in ${this.sttTestResult.latencyMs} ms`,
        );
      } else {
        this.toast.warn('Test failed', this.sttTestResult.error);
      }
    } catch (err) {
      this.sttTestResult = {
        ok: false,
        provider: provider.id,
        model: provider.selectedModel,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.testing = false;
      this.cdr.markForCheck();
    }
  }

  private previewRevoke: (() => void) | null = null;

  protected async onPreviewTts(): Promise<void> {
    const provider = this.ttsProvider;
    if (!provider) return;

    this.previewing = true;
    this.ttsPreviewError = null;
    try {
      if (provider.id === 'browser') {
        this.previewBrowserVoice();
        return;
      }
      this.previewRevoke?.();
      const { url, revoke } = await this.admin.previewSpeechOutput(provider.id, {
        model: provider.selectedModel,
        voice: provider.selectedVoice,
      });
      this.previewRevoke = revoke;
      const audio = new Audio(url);
      audio.addEventListener('ended', () => revoke(), { once: true });
      await audio.play();
    } catch (err) {
      this.ttsPreviewError = err instanceof Error ? err.message : String(err);
      this.toast.error('Preview failed', this.ttsPreviewError);
    } finally {
      this.previewing = false;
      this.cdr.markForCheck();
    }
  }

  // ── Live voice catalogs ──────────────────────────────────────────────────

  private voiceKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  protected get voiceOptions(): Array<{ label: string; value: string }> {
    const provider = this.ttsProvider;
    if (!provider) return [];
    const live = this.voiceCatalog.get(this.voiceKey(provider.id, provider.selectedModel));
    return (live ?? provider.voices).map((v) => ({
      label: v.note ? `${v.label} — ${v.note}` : v.label,
      value: v.id,
    }));
  }

  protected async loadVoiceCatalog(id: SpeechOutputProviderId): Promise<void> {
    const provider = this.ttsProviders.find((p) => p.id === id);
    if (!provider || !provider.capabilities.livesVoiceCatalog || !provider.available) return;

    this.loadingVoices = true;
    try {
      const res = await this.admin.getSpeechVoices(id, provider.selectedModel);
      if (res.live) this.voiceCatalog.set(this.voiceKey(id, res.model), res.voices);
      if (res.error) this.toast.warn('Could not load the live voice list', res.error);
    } catch (err) {
      this.toast.warn('Could not load the live voice list', err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingVoices = false;
      this.cdr.markForCheck();
    }
  }

  protected onTtsModelChange(): void {
    const provider = this.ttsProvider;
    if (!provider) return;
    // A new model usually means a new voice catalog and a new default voice.
    provider.selectedVoice = provider.defaultVoice;
    void this.loadVoiceCatalog(provider.id);
  }

  // ── Browser voices (device-local) ────────────────────────────────────────

  protected browserVoiceUri = '';
  protected browserTtsRate = 1.02;
  protected browserTtsPitch = 1;
  protected browserTtsVolume = 1;
  protected browserTtsLang = 'en-US';
  protected browserProfiles: BrowserTtsProfile[] = [];
  protected browserVoiceOptions: BrowserVoiceOption[] = [];
  private browserVoiceSource: BrowserVoiceOption[] = [];
  protected browserVoiceFilter = '';
  protected browserVoicesLoading = false;
  protected browserVoicesShowAll = false;
  protected browserVoicesTotal = 0;
  protected browserVoicesShown = 0;
  protected browserVoicesLoaded = 0;
  private rawBrowserVoices: SpeechSynthesisVoice[] = [];
  private browserVoiceSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubBrowserVoices: (() => void) | null = null;
  protected readonly currentBrowserLabel = detectBrowserLabel();
  protected readonly currentBrowserId = currentBrowserProfileId();

  /** ISO-639-1 codes this device can actually speak. */
  protected get deviceLanguages(): string[] {
    return browserVoiceLanguages();
  }

  protected get deviceSpeaksSelectedLanguage(): boolean {
    const language = this.view()?.tts.effectiveLanguage;
    if (!language || language === 'auto') return true;
    return this.deviceLanguages.includes(language);
  }

  private voiceToOption(v: SpeechSynthesisVoice): BrowserVoiceOption {
    return { label: `${v.name} (${v.lang})${v.localService ? '' : ' · remote'}`, value: v.voiceURI };
  }

  private lazyPad(index: number): BrowserVoiceOption {
    return { label: '…', value: `__lazy_${index}`, disabled: true };
  }

  private buildBrowserVoiceSource(voices: SpeechSynthesisVoice[]): BrowserVoiceOption[] {
    const curated = curateBrowserTtsVoices(voices, {
      preferredLang: this.browserTtsLang,
      selectedVoiceURI: this.browserVoiceUri,
      includeRemote: this.browserVoicesShowAll,
      maxVoices: this.browserVoicesShowAll ? undefined : BROWSER_VOICE_CURATED_MAX,
    });
    this.browserVoicesShown = curated.length;
    return curated.map((v) => this.voiceToOption(v));
  }

  private filteredBrowserVoiceSource(): BrowserVoiceOption[] {
    const q = this.browserVoiceFilter.trim().toLowerCase();
    if (!q) return this.browserVoiceSource;
    return this.browserVoiceSource.filter((o) => o.label.toLowerCase().includes(q));
  }

  /**
   * Keep the option array the same length as the filtered catalog so the
   * virtual scrollbar is honest, but only materialize the visible window —
   * Firefox can report several hundred voices and freezes the overlay.
   */
  private fillBrowserVoiceWindow(first: number, last: number): void {
    const source = this.filteredBrowserVoiceSource();
    const from = Math.max(0, first);
    const to = Math.min(source.length, Math.max(last, from + BROWSER_VOICE_LAZY_CHUNK));

    const next: BrowserVoiceOption[] = new Array(source.length);
    for (let i = 0; i < source.length; i++) {
      next[i] = i >= from && i < to ? source[i]! : this.lazyPad(i);
    }

    const selectedIdx = source.findIndex((o) => o.value === this.browserVoiceUri);
    if (selectedIdx >= 0) next[selectedIdx] = source[selectedIdx]!;

    this.browserVoicesLoaded = to - from;
    this.browserVoiceOptions = next;
  }

  private applyBrowserVoiceOptions(voices: SpeechSynthesisVoice[]): void {
    this.rawBrowserVoices = voices;
    this.browserVoicesTotal = voices.length;
    this.browserVoiceSource = this.buildBrowserVoiceSource(voices);
    this.fillBrowserVoiceWindow(0, BROWSER_VOICE_LAZY_CHUNK);
    this.cdr.markForCheck();
  }

  protected onBrowserVoicesShowAllChange(): void {
    this.browserVoiceFilter = '';
    this.applyBrowserVoiceOptions(this.rawBrowserVoices);
  }

  protected onBrowserVoicesLazyLoad(event: SelectLazyLoadEvent): void {
    this.fillBrowserVoiceWindow(event.first, event.last);
    this.cdr.markForCheck();
  }

  protected onBrowserVoiceSearch(query: string): void {
    this.browserVoiceFilter = query;
    if (this.browserVoiceSearchTimer) clearTimeout(this.browserVoiceSearchTimer);
    this.browserVoiceSearchTimer = setTimeout(() => {
      this.browserVoiceSearchTimer = null;
      this.fillBrowserVoiceWindow(0, BROWSER_VOICE_LAZY_CHUNK);
      this.cdr.markForCheck();
    }, 120);
  }

  private async loadBrowserVoices(): Promise<void> {
    this.browserProfiles = listBrowserTtsProfiles();
    const current = this.browserProfiles.find((p) => p.id === this.currentBrowserId);
    const opts = current?.options ?? {};
    this.browserVoiceUri = opts.voiceURI ?? '';
    this.browserTtsRate = opts.rate ?? 1.02;
    this.browserTtsPitch = opts.pitch ?? 1;
    this.browserTtsVolume = opts.volume ?? 1;
    this.browserTtsLang = opts.lang ?? 'en-US';

    this.browserVoicesLoading = true;
    try {
      this.applyBrowserVoiceOptions(await listBrowserTtsVoicesAsync());
    } finally {
      this.browserVoicesLoading = false;
      this.cdr.markForCheck();
    }
  }

  /** Browser voice settings are per-device and live in localStorage, not config.json. */
  private saveBrowserProfile(): void {
    saveBrowserTtsProfile(this.currentBrowserId, {
      ...(this.browserVoiceUri ? { voiceURI: this.browserVoiceUri } : {}),
      rate: Number(this.browserTtsRate),
      pitch: Number(this.browserTtsPitch),
      volume: Number(this.browserTtsVolume),
      lang: this.browserTtsLang.trim() || 'en-US',
    }, this.currentBrowserLabel);
    this.browserProfiles = listBrowserTtsProfiles();
    this.voiceSession.refreshBrowserTtsOptions();
  }

  protected onLoadBrowserProfile(profile: BrowserTtsProfile): void {
    this.browserVoiceUri = profile.options.voiceURI ?? '';
    this.browserTtsRate = profile.options.rate ?? 1.02;
    this.browserTtsPitch = profile.options.pitch ?? 1;
    this.browserTtsVolume = profile.options.volume ?? 1;
    this.browserTtsLang = profile.options.lang ?? 'en-US';
    this.applyBrowserVoiceOptions(this.rawBrowserVoices);
    this.toast.success('Profile loaded', profile.label);
  }

  protected onDeleteBrowserProfile(id: string): void {
    deleteBrowserTtsProfile(id);
    this.browserProfiles = listBrowserTtsProfiles();
    this.cdr.markForCheck();
  }

  private previewBrowserVoice(): void {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      this.ttsPreviewError = 'This browser has no speechSynthesis support.';
      return;
    }
    const utterance = new SpeechSynthesisUtterance(
      'This is the AgentVoice preview. Speaking a file path: src slash providers slash speech.',
    );
    const voice = this.rawBrowserVoices.find((v) => v.voiceURI === this.browserVoiceUri);
    if (voice) utterance.voice = voice;
    utterance.rate = Number(this.browserTtsRate);
    utterance.pitch = Number(this.browserTtsPitch);
    utterance.volume = Number(this.browserTtsVolume);
    utterance.lang = this.browserTtsLang.trim() || 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  // ── Self-hosted speech server ────────────────────────────────────────────

  protected server: SpeechServerStatus | null = null;
  protected serverForm: SpeechServerSettings | null = null;
  protected serverBaseUrlInput = '';
  protected loadingServer = false;
  protected savingServer = false;
  protected stoppingServer = false;
  protected serverLogs = '';
  protected loadingServerLogs = false;
  protected settingUpServer = false;
  protected setupLog: string[] = [];
  protected setupError: string | null = null;
  private setupRunId: string | null = null;
  private setupPollTimer: ReturnType<typeof setTimeout> | null = null;
  private setupProgressSub: Subscription | null = null;

  protected readonly serverManageOptions = [
    { label: 'Run a container here', value: 'container' },
    { label: 'Use a server I already run', value: 'external' },
  ];

  protected readonly serverRuntimeOptions = [
    { label: 'Auto-detect', value: 'auto' },
    { label: 'Docker', value: 'docker' },
    { label: 'Podman', value: 'podman' },
  ];

  /** Anything exposing OpenAI-compatible speech routes works; these are curated. */
  protected readonly serverImageOptions = [
    { label: 'speaches (CPU) — faster-whisper + Kokoro', value: 'ghcr.io/speaches-ai/speaches:latest-cpu' },
    { label: 'speaches (CUDA) — NVIDIA GPU', value: 'ghcr.io/speaches-ai/speaches:latest-cuda' },
  ];

  /** The server panel is only relevant when a local provider is selected. */
  protected get needsServerPanel(): boolean {
    return this.selectedStt === 'local_whisper' || this.selectedTts === 'local_speech';
  }

  protected async loadServerStatus(): Promise<void> {
    this.loadingServer = true;
    try {
      this.server = await this.admin.getSpeechServerStatus();
      this.serverForm = structuredClone(this.view()?.server ?? null);
      this.serverBaseUrlInput = this.serverForm?.baseUrl ?? '';
      // Re-attach to a run started elsewhere or before a reload.
      if (this.server.setupRunning && this.server.setupRunId && !this.settingUpServer) {
        this.settingUpServer = true;
        this.setupRunId = this.server.setupRunId;
        this.subscribeToSetupProgress(this.server.setupRunId);
        this.pollSetupRun(this.server.setupRunId);
      }
    } catch (err) {
      this.toast.error('Could not read the speech server status', err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingServer = false;
      this.cdr.markForCheck();
    }
  }

  protected get runtimeHint(): string | null {
    const runtimes = this.server?.runtimes ?? [];
    if (runtimes.length === 0) return null;
    const usable = runtimes.filter((r) => r.usable);
    if (usable.length === 0) {
      return 'Neither Docker nor Podman is usable here — install one, or point at a server you run elsewhere.';
    }
    return usable.map((r) => `${r.id} ${r.version ?? ''}`.trim()).join(' · ');
  }

  protected async onSaveServer(): Promise<void> {
    if (!this.serverForm) return;
    this.savingServer = true;
    try {
      const res = await this.admin.patchSpeechInput({
        server: { ...this.serverForm, baseUrl: this.serverBaseUrlInput.trim() },
      });
      this.savingServer = false;
      this.applyView(res);
      await this.loadServerStatus();
      this.toast.success('Speech server settings saved');
    } catch (err) {
      this.toast.error('Could not save the speech server settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingServer = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Pull the image, start the container, and install the models each direction
   * needs. Minutes-long, so the bridge runs it detached and we stream progress
   * (with a polling fallback for when the control socket drops).
   */
  protected async onRunSetup(): Promise<void> {
    this.settingUpServer = true;
    this.setupLog = [];
    this.setupError = null;
    try {
      // Persist edits first — setup reads the saved config, not the form.
      if (this.serverForm) await this.onSaveServer();
      const { runId } = await this.admin.startSpeechServerSetup();
      this.setupRunId = runId;
      this.subscribeToSetupProgress(runId);
      this.pollSetupRun(runId);
    } catch (err) {
      this.settingUpServer = false;
      this.setupError = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not start setup', this.setupError);
    }
  }

  private subscribeToSetupProgress(runId: string): void {
    this.setupProgressSub?.unsubscribe();
    this.setupProgressSub = this.bridge.speechSetupProgress$.subscribe((event) => {
      if (event.runId !== runId) return;
      if (event.message) this.setupLog = [...this.setupLog, event.message];
      if (event.error) this.setupError = event.error;
      if (event.done) this.finishSetup(runId, !event.error);
      this.cdr.markForCheck();
    });
  }

  private pollSetupRun(runId: string): void {
    if (this.setupPollTimer) clearTimeout(this.setupPollTimer);
    const poll = async () => {
      if (this.setupRunId !== runId) return;
      try {
        const status = await this.admin.getSpeechServerSetupRun(runId);
        const seen = new Set(this.setupLog);
        for (const event of status.events) {
          if (event.message && !seen.has(event.message)) {
            this.setupLog = [...this.setupLog, event.message];
            seen.add(event.message);
          }
          if (event.error) this.setupError = event.error;
        }
        this.cdr.markForCheck();
        if (status.done) {
          this.finishSetup(runId, status.result?.ok !== false);
          return;
        }
      } catch {
        // Transient — keep polling until the run resolves or we're destroyed.
      }
      this.setupPollTimer = setTimeout(() => void poll(), 2000);
    };
    this.setupPollTimer = setTimeout(() => void poll(), 2000);
  }

  private finishSetup(runId: string, ok: boolean): void {
    if (this.setupRunId !== runId) return;
    this.settingUpServer = false;
    this.setupRunId = null;
    if (this.setupPollTimer) {
      clearTimeout(this.setupPollTimer);
      this.setupPollTimer = null;
    }
    this.setupProgressSub?.unsubscribe();
    this.setupProgressSub = null;
    if (ok) this.toast.success('Self-hosted speech server is ready');
    else this.toast.warn('Setup finished with issues', this.setupError ?? undefined);
    void this.reload();
  }

  protected async onStopServer(remove = false): Promise<void> {
    this.stoppingServer = true;
    try {
      const res = await this.admin.stopSpeechServer(remove);
      this.server = res.status;
      if (res.ok) this.toast.success(res.detail);
      else this.toast.warn('Could not stop the container', res.detail);
    } catch (err) {
      this.toast.error('Could not stop the container', err instanceof Error ? err.message : String(err));
    } finally {
      this.stoppingServer = false;
      this.cdr.markForCheck();
    }
  }

  protected async onLoadServerLogs(): Promise<void> {
    this.loadingServerLogs = true;
    try {
      this.serverLogs = (await this.admin.getSpeechServerLogs(120)).text || '(no output yet)';
    } catch (err) {
      this.serverLogs = err instanceof Error ? err.message : String(err);
    } finally {
      this.loadingServerLogs = false;
      this.cdr.markForCheck();
    }
  }
}
