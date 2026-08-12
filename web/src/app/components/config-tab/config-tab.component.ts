import type { ElementRef, OnDestroy, OnInit } from '@angular/core';
import { ChangeDetectorRef, Component, computed, inject, signal, viewChild } from '@angular/core';
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
import { Password } from '@openng/optimus-ui/password';
import { ProgressSpinner } from '@openng/optimus-ui/progressspinner';
import { PrimeTemplate } from '@openng/optimus-ui/api';
import { Select } from '@openng/optimus-ui/select';
import type { SelectLazyLoadEvent } from '@openng/optimus-ui/types/select';
import { SelectButton } from '@openng/optimus-ui/selectbutton';
import { Tag } from '@openng/optimus-ui/tag';
import { Textarea } from '@openng/optimus-ui/textarea';
import { ToggleSwitch } from '@openng/optimus-ui/toggleswitch';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '@openng/optimus-ui/tabs';

import { phrasesConflict } from '../../../wake-words.js';
import {
  currentBrowserProfileId,
  deleteBrowserTtsProfile,
  detectBrowserLabel,
  curateBrowserTtsVoices,
  listBrowserTtsProfiles,
  listBrowserTtsVoicesAsync,
  onBrowserTtsVoicesChanged,
  saveBrowserTtsProfile,
  type BrowserTtsProfile,
} from '../../../browser-tts-settings.js';
import { speakAmazonPolly } from '../../../amazon-tts.js';
import {
  APPEARANCE_TONES,
  AppearanceService,
  type AppearanceScheme,
} from '../../services/appearance.service';
import { AdminService } from '../../services/admin.service';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { ConnectionTabComponent } from '../connection-tab/connection-tab.component';
import type {
  AdminProject,
  AuditEntry,
  AwsKeyStatus,
  DbStats,
  HostingSettings,
  ServeSettings,
  ServeStatus,
  ServeEvent,
  ServeActionId,
  JobSettings,
  NarratorSettings,
  WorkflowSettings,
  AgentClientSettings,
  AgentClientId,
  PollyVoiceInfo,
  TtsProvider,
  TranscribeLanguageMode,
  TranscribeModelId,
  TranscribePartialStability,
  HostingProviderId,
  HostingProviderInfo,
  HostingDoctorResult,
} from '../../models/admin-settings';
// ── Section definition ─────────────────────────────────────────────────────

type SectionId =
  | 'appearance'
  | 'connection'
  | 'voice'
  | 'personal'
  | 'projects'
  | 'keys'
  | 'workflow'
  | 'agent-client'
  | 'serve'
  | 'jobs'
  | 'narrator'
  | 'database'
  | 'debug';

type BrowserVoiceOption = { label: string; value: string; disabled?: boolean };

const BROWSER_VOICE_LAZY_CHUNK = 64;
const BROWSER_VOICE_CURATED_MAX = 80;

type ServeTabId = 'status' | 'network' | 'logs';

interface ConfigSection {
  id: SectionId;
  label: string;
  icon: string;
  description: string;
  keywords: string[];
}

const ALL_SECTIONS: ConfigSection[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'pi-palette',
    description: 'Light / dark / system and primary color tone',
    keywords: ['appearance', 'theme', 'dark', 'light', 'system', 'color', 'tone', 'palette', 'mode'],
  },
  {
    id: 'connection',
    label: 'Connection',
    icon: 'pi-wifi',
    description: 'Bridge URL, app token, connection status',
    keywords: ['bridge', 'token', 'url', 'connect', 'disconnect', 'server'],
  },
  {
    id: 'voice',
    label: 'Voice & Controls',
    icon: 'pi-microphone',
    description: 'Wake words, on-screen controls, turn submit, TTS, and transcription',
    keywords: ['wake', 'phrase', 'vad', 'silence', 'start', 'end', 'cancel', 'audio', 'sound', 'cue', 'tts', 'voice', 'interrupt', 'browser', 'polly', 'transcribe', 'sfm', 'speech', 'stt', 'touch', 'mute', 'speak'],
  },
  {
    id: 'personal',
    label: 'Personal',
    icon: 'pi-user',
    description: 'Your name used by the voice agent',
    keywords: ['name', 'user', 'personal', 'address'],
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: 'pi-folder-open',
    description: 'Manage workspace paths, aliases, and enabled state',
    keywords: ['project', 'workspace', 'path', 'alias', 'folder', 'repo', 'enable', 'disable'],
  },
  {
    id: 'keys',
    label: 'AWS Bedrock Keys',
    icon: 'pi-key',
    description: 'IAM access key, secret, region — test credentials with a live ping',
    keywords: ['aws', 'bedrock', 'key', 'iam', 'access', 'secret', 'region', 'credential', 'polly', 'transcribe'],
  },
  {
    id: 'workflow',
    label: 'LLM & Workflow',
    icon: 'pi-microchip-ai',
    description: 'Default workflow, model, region, audio settings, conversation memory',
    keywords: ['llm', 'model', 'workflow', 'cursor', 'claude', 'sonnet', 'polly', 'voice', 'tts', 'stt', 'memory', 'webkit', 'tokens'],
  },
  {
    id: 'agent-client',
    label: 'Agent Client',
    icon: 'pi-microchip-ai',
    description: 'Select the AI coding agent: Cursor, Codex, or Claude Code',
    keywords: ['agent', 'client', 'cursor', 'codex', 'claude', 'claude-code', 'openai', 'anthropic', 'binary', 'path'],
  },
  {
    id: 'serve',
    label: 'Serve',
    icon: 'pi-server',
    description: 'Health check, live service logs, restart, and rebase onto origin',
    keywords: ['serve', 'host', 'port', 'url', 'tailscale', 'rebase', 'restart', 'git', 'journal', 'journalctl', 'health', 'network', 'systemd'],
  },
  {
    id: 'jobs',
    label: 'Job Settings',
    icon: 'pi-cog',
    description: 'Concurrency, timeouts, plan-first mode, pre-run flags, ghost kill',
    keywords: ['job', 'timeout', 'concurrent', 'plan', 'flags', 'ghost', 'kill', 'cache', 'mode', 'agent'],
  },
  {
    id: 'narrator',
    label: 'Narrator',
    icon: 'pi-volume-up',
    description: 'Voice narration enabled, cadence interval, event buffer',
    keywords: ['narrator', 'narration', 'cadence', 'buffer', 'speak', 'voice', 'interval'],
  },
  {
    id: 'database',
    label: 'Database & Sessions',
    icon: 'pi-database',
    description: 'DB path, table stats, session state, audit log',
    keywords: ['database', 'db', 'sqlite', 'session', 'audit', 'log', 'history', 'jobs', 'events'],
  },
  {
    id: 'debug',
    label: 'Debug & Logs',
    icon: 'pi-wrench',
    description: 'Log level, raw config.json editor',
    keywords: ['debug', 'log', 'level', 'trace', 'json', 'config', 'raw', 'editor'],
  },
];

// ── Hosting provider (Network tab) ─────────────────────────────────────────

/** Providers with `autoSetup: false` (or that need no CLI) sort last — Hick's Law. */
const HOSTING_PROVIDER_ORDER: HostingProviderId[] = [
  'tailscale',
  'cloudflare',
  'ngrok',
  'devtunnel',
  'lan',
  'local',
  'manual',
];

interface HostnameFieldMeta {
  label: string;
  placeholder: string;
  required: boolean;
  hint: string;
}

/** Only providers whose setup() actually reads `opts.hostname` show the field. */
const HOSTING_HOSTNAME_FIELD: Partial<Record<HostingProviderId, HostnameFieldMeta>> = {
  tailscale: {
    label: 'Device name (optional)',
    placeholder: 'e.g. my-laptop',
    required: false,
    hint: '`tailscale up --hostname=` — leave blank to keep the current name.',
  },
  cloudflare: {
    label: 'Stable hostname (optional)',
    placeholder: 'voice.example.com',
    required: false,
    hint: 'Leave blank for a rotating *.trycloudflare.com quick tunnel.',
  },
  manual: {
    label: 'Public URL',
    placeholder: 'https://voice.example.com',
    required: true,
    hint: 'The HTTPS URL your own reverse proxy already serves.',
  },
};

const HOSTING_LOGIN_SERVER_FIELD: Partial<Record<HostingProviderId, HostnameFieldMeta>> = {
  tailscale: {
    label: 'Headscale login server (optional)',
    placeholder: 'https://headscale.example.com',
    required: false,
    hint: 'Leave blank to use Tailscale\u2019s own coordination server.',
  },
};

// ── Component ──────────────────────────────────────────────────────────────

@Component({
  selector: 'cv-config-tab',
  standalone: true,
  imports: [
    FormsModule,
    Button,
    Divider,
    Fieldset,
    Fluid,
    IftaLabel,
    InputNumber,
    InputText,
    Message,
    Password,
    ProgressSpinner,
    Select,
    SelectButton,
    Tag,
    Textarea,
    ToggleSwitch,
    Tabs,
    TabList,
    Tab,
    TabPanels,
    TabPanel,
    PrimeTemplate,
    ConnectionTabComponent,
  ],
  templateUrl: './config-tab.component.html',
})
export class ConfigTabComponent implements OnInit, OnDestroy {
  protected readonly bridge = inject(BridgeService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  protected readonly voiceSession = inject(VoiceSessionService);
  protected readonly admin = inject(AdminService);
  protected readonly appearance = inject(AppearanceService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly toast = inject(ToastService);
  private unsubBrowserVoices: (() => void) | null = null;

  protected readonly appearanceSchemeOptions: Array<{ label: string; value: AppearanceScheme }> = [
    { label: 'Light', value: 'light' },
    { label: 'Dark', value: 'dark' },
    { label: 'System', value: 'system' },
  ];

  protected readonly appearanceToneOptions = APPEARANCE_TONES.map((tone) => ({
    label: tone.charAt(0).toUpperCase() + tone.slice(1),
    value: tone,
  }));

  protected get appearanceScheme(): AppearanceScheme {
    return this.appearance.settings().scheme;
  }

  protected set appearanceScheme(scheme: AppearanceScheme) {
    this.appearance.setScheme(scheme);
  }

  protected get appearanceTone(): string {
    return this.appearance.settings().tone;
  }

  protected set appearanceTone(tone: string) {
    this.appearance.setTone(tone);
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  protected readonly activeSection = signal<SectionId | null>(null);
  protected readonly searchQuery = signal('');

  protected readonly allSections = ALL_SECTIONS;

  protected readonly filteredSections = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return ALL_SECTIONS;
    return ALL_SECTIONS.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.keywords.some((k) => k.includes(q)),
    );
  });

  protected readonly activeSectionMeta = computed(() =>
    ALL_SECTIONS.find((s) => s.id === this.activeSection()) ?? null,
  );

  protected readonly isBridgeConnected = computed(
    () => this.bridge.wsStatus() === 'connected',
  );

  /** HTTP API works with stored credentials — WebSocket is not required. */
  protected readonly canUseApi = computed(() => this.bridge.hasCredentials());

  protected navigateTo(id: SectionId): void {
    this.cancelInFlightLoads();
    this.activeSection.set(id);
    void this.loadSection(id);
  }

  /** Invalidate in-flight section loads when navigating away. */
  private cancelInFlightLoads(): void {
    this.projectsLoadSeq++;
    this.loadingProjects = false;
    this.keysLoadSeq++;
    this.loadingKeys = false;
    this.workflowLoadSeq++;
    this.loadingWorkflow = false;
    this.agentClientLoadSeq++;
    this.loadingAgentClient = false;
    this.serveLoadSeq++;
    this.loadingServe = false;
    this.stopJournalStream();
    this.jobsLoadSeq++;
    this.loadingJobs = false;
    this.narratorLoadSeq++;
    this.loadingNarrator = false;
    this.dbLoadSeq++;
    this.loadingDb = false;
    this.jsonLoadSeq++;
    this.loadingJson = false;
  }

  protected goBack(): void {
    this.activeSection.set(null);
    this.searchQuery.set('');
    this.stopJournalStream();
  }

  // ── Select options ──────────────────────────────────────────────────────

  protected readonly workflowOptions = [
    { label: 'Cursor Native', value: 'cursor_native' },
    { label: 'LLM Intelligence (Bedrock)', value: 'llm_intelligence' },
  ];

  protected readonly pollyEngineOptions = [
    { label: 'Neural', value: 'neural' },
    { label: 'Generative', value: 'generative' },
    { label: 'Standard', value: 'standard' },
  ];

  protected readonly ttsProviderOptions: Array<{ label: string; value: TtsProvider }> = [
    { label: 'Browser text-to-speech', value: 'browser' },
    { label: 'Amazon Polly', value: 'amazon_polly' },
  ];

  protected readonly transcribeModelOptions: Array<{ label: string; value: TranscribeModelId }> = [
    {
      label: 'Speech Foundation Model (SFM) — recommended',
      value: 'speech_foundation_model',
    },
  ];

  protected readonly transcribeLanguageModeOptions: Array<{
    label: string;
    value: TranscribeLanguageMode;
  }> = [
    { label: 'Fixed language (fastest)', value: 'fixed' },
    { label: 'Auto-identify (slower, multilingual)', value: 'identify' },
  ];

  protected readonly transcribeStabilityOptions: Array<{
    label: string;
    value: TranscribePartialStability;
  }> = [
    { label: 'High — lowest latency', value: 'high' },
    { label: 'Medium — balanced', value: 'medium' },
    { label: 'Low — highest accuracy on revisions', value: 'low' },
  ];

  protected readonly runModeOptions = [
    { label: 'Test (local dev)', value: 'test' },
    { label: 'Serve (production)', value: 'serve' },
  ];

  protected readonly defaultModeOptions = [
    { label: 'Agent', value: 'agent' },
    { label: 'Plan', value: 'plan' },
  ];

  protected readonly logLevelOptions = [
    { label: 'Trace', value: 'trace' },
    { label: 'Debug', value: 'debug' },
    { label: 'Info', value: 'info' },
    { label: 'Warn', value: 'warn' },
    { label: 'Error', value: 'error' },
  ];

  // ── Lifecycle ───────────────────────────────────────────────────────────

  ngOnInit(): void {
    void this.voiceProviders.refresh().then(() => this.syncVoiceForm());
  }

  ngOnDestroy(): void {
    if (this.browserVoiceSearchTimer) {
      clearTimeout(this.browserVoiceSearchTimer);
      this.browserVoiceSearchTimer = null;
    }
    this.unsubBrowserVoices?.();
    this.unsubBrowserVoices = null;
    if (this.hostingSetupPollTimer) clearTimeout(this.hostingSetupPollTimer);
    this.hostingProgressSub?.unsubscribe();
    this.stopJournalStream();
  }

  private async loadSection(id: SectionId): Promise<void> {
    if (!this.canUseApi()) return;
    switch (id) {
      case 'voice':
        await this.voiceProviders.refresh();
        this.syncVoiceForm();
        await this.loadSpeechOutputUi();
        break;
      case 'personal':
        this.syncVoiceForm();
        break;
      case 'projects':
        await this.loadProjects();
        break;
      case 'keys':
        await this.loadKeys();
        break;
      case 'workflow':
        await this.loadWorkflow();
        break;
      case 'agent-client':
        await this.loadAgentClient();
        break;
      case 'serve':
        await this.loadServe();
        break;
      case 'jobs':
        await this.loadJobs();
        break;
      case 'narrator':
        await this.loadNarrator();
        break;
      case 'database':
        await this.loadDatabase();
        break;
      case 'debug':
        await this.loadRawJson();
        break;
    }
  }

  // ── Voice section ────────────────────────────────────────────────────────

  protected wakeStart = '';
  protected wakeEnd = 'send';
  protected wakeCancel = 'cancel';
  protected wakeConfidencePercent = 45;
  protected vadEnabled = true;
  protected silenceSubmitMs = 1500;
  protected workerPollTimeoutMs = 25_000;
  protected savingVoice = false;

  protected touchControls: 'off' | 'when_muted' | 'always' = 'when_muted';
  protected wakeWordsEnabled = true;
  protected defaultMicMuted = false;
  protected savingTouchUi = false;
  protected readonly touchControlsOptions: Array<{ label: string; value: 'off' | 'when_muted' | 'always' }> = [
    { label: 'When muted', value: 'when_muted' },
    { label: 'Always', value: 'always' },
    { label: 'Off', value: 'off' },
  ];

  protected cursorVoiceEnabled = true;
  protected errorSoundEnabled = true;
  protected errorSpeakEnabled = true;
  protected webkitRate = 1.02;
  protected webkitPitch = 1;
  protected webkitVolume = 1;
  protected webkitLang = 'en-US';
  protected savingTts = false;

  protected browserVoiceUri = '';
  protected browserTtsRate = 1.02;
  protected browserTtsPitch = 1;
  protected browserTtsVolume = 1;
  protected browserTtsLang = 'en-US';
  protected browserProfiles: BrowserTtsProfile[] = [];
  /**
   * Sparse options bound to p-select: length === filtered catalog for correct
   * virtual-scroll height; only the visible window holds real rows.
   */
  protected browserVoiceOptions: BrowserVoiceOption[] = [];
  /** Active catalog (curated or all) — full objects in memory for search/lazy. */
  private browserVoiceSource: BrowserVoiceOption[] = [];
  /** Search query for the custom Select filter (does not use Select’s built-in filter). */
  protected browserVoiceFilter = '';
  protected browserVoicesLoading = false;
  protected browserVoicesShowAll = false;
  protected browserVoicesTotal = 0;
  protected browserVoicesShown = 0;
  protected browserVoicesLoaded = 0;
  private rawBrowserVoices: SpeechSynthesisVoice[] = [];
  private browserVoiceSearchTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly currentBrowserLabel = detectBrowserLabel();
  protected readonly currentBrowserId = currentBrowserProfileId();

  /** Speech output (TTS) — synced with workflow.llmIntelligence.audio */
  protected ttsProvider: TtsProvider = 'browser';
  protected pollyVoiceId = 'Joanna';
  protected pollyEngine: 'standard' | 'neural' | 'generative' = 'neural';
  protected pollyVoiceOptions: Array<{ label: string; value: string }> = [];
  protected pollyVoices: PollyVoiceInfo[] = [];
  protected loadingPollyVoices = false;
  protected savingSpeechOutput = false;
  protected previewingPolly = false;

  protected transcribeModel: TranscribeModelId = 'speech_foundation_model';
  protected transcribeLanguageMode: TranscribeLanguageMode = 'fixed';
  protected transcribeLanguageCode = 'en-US';
  protected transcribeLanguageOptions = 'en-US,es-US,fr-FR,de-DE';
  protected transcribePreferredLanguage = 'en-US';
  protected transcribePartialResultsStabilization = true;
  protected transcribePartialResultsStability: TranscribePartialStability = 'high';
  protected savingSpeechInput = false;

  protected readonly wakeConfidencePresets = [
    { label: '45% — fast (partial)', value: 45 },
    { label: '65% — balanced', value: 65 },
    { label: '80% — strict', value: 80 },
  ];

  protected readonly phraseConflict = computed(() => {
    if (this.vadEnabled) return false;
    return phrasesConflict(this.wakeStart, this.wakeEnd);
  });

  protected async onSaveVoiceSettings(): Promise<void> {
    const start = this.wakeStart.trim();
    const end = this.wakeEnd.trim();
    const cancel = this.wakeCancel.trim();
    if (!start) {
      this.toast.warn('Activation phrase required', 'Set a non-empty start phrase.');
      return;
    }
    if (!this.vadEnabled && phrasesConflict(start, end)) {
      this.toast.warn('Phrase conflict', 'Wake and end phrases must differ when VAD is off.');
      return;
    }
    const silenceMs = Number(this.silenceSubmitMs);
    if (!Number.isFinite(silenceMs) || silenceMs < 500 || silenceMs > 30_000) {
      this.toast.warn('Invalid silence duration', 'Use a value between 500 and 30000 ms.');
      return;
    }
    const wakeConfidenceThreshold = Number(this.wakeConfidencePercent) / 100;
    if (
      !Number.isFinite(wakeConfidenceThreshold) ||
      wakeConfidenceThreshold < 0 ||
      wakeConfidenceThreshold > 1
    ) {
      this.toast.warn('Invalid wake confidence', 'Use a value between 0% and 100%.');
      return;
    }
    const workerPollTimeoutMs = Number(this.workerPollTimeoutMs);
    if (
      !Number.isFinite(workerPollTimeoutMs) ||
      workerPollTimeoutMs < 5_000 ||
      workerPollTimeoutMs > 60_000
    ) {
      this.toast.warn('Invalid worker poll interval', 'Use a value between 5000 and 60000 ms.');
      return;
    }
    this.savingVoice = true;
    try {
      await this.voiceProviders.updateWakeWords(
        start,
        end,
        silenceMs,
        this.vadEnabled,
        cancel,
        wakeConfidenceThreshold,
        workerPollTimeoutMs,
      );
      this.syncVoiceForm();
      this.toast.success(
        'Voice settings saved',
        this.voiceSession.conversationActive()
          ? 'Tap the orb to hang up, then restart to apply.'
          : 'Settings apply the next time you tap the orb.',
      );
    } catch (err) {
      this.toast.error('Could not save voice settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingVoice = false;
    }
  }

  private syncVoiceForm(): void {
    const data = this.voiceProviders.data();
    if (data?.wakeWords.start) this.wakeStart = data.wakeWords.start;
    if (data?.wakeWords.end) this.wakeEnd = data.wakeWords.end;
    if (data?.wakeWords.cancel) this.wakeCancel = data.wakeWords.cancel;
    if (data?.wakeWords.wakeConfidenceThreshold !== undefined) {
      this.wakeConfidencePercent = Math.round(data.wakeWords.wakeConfidenceThreshold * 100);
    }
    if (data?.turnSubmit.silenceMs) this.silenceSubmitMs = Number(data.turnSubmit.silenceMs);
    if (data?.turnSubmit.vadEnabled !== undefined) this.vadEnabled = data.turnSubmit.vadEnabled;
    if (data?.workerPollTimeoutMs) this.workerPollTimeoutMs = Number(data.workerPollTimeoutMs);
    this.userName = data?.userName ?? '';
    if (data?.tts) {
      this.cursorVoiceEnabled = data.tts.cursorVoiceEnabled;
      this.errorSoundEnabled = data.tts.errorSoundEnabled ?? true;
      this.errorSpeakEnabled = data.tts.errorSpeakEnabled ?? true;
      this.webkitRate = data.tts.webkit.rate;
      this.webkitPitch = data.tts.webkit.pitch;
      this.webkitVolume = data.tts.webkit.volume;
      this.webkitLang = data.tts.webkit.lang;
    }
    this.touchControls = data?.touchControls ?? 'when_muted';
    this.wakeWordsEnabled = data?.wakeWordsEnabled !== false;
    this.defaultMicMuted = data?.defaultMicMuted === true;
  }

  protected async onSaveTouchUi(): Promise<void> {
    this.savingTouchUi = true;
    try {
      await this.voiceProviders.updateVoiceUi({
        touchControls: this.touchControls,
        wakeWordsEnabled: this.wakeWordsEnabled,
        defaultMicMuted: this.defaultMicMuted,
      });
      this.syncVoiceForm();
      this.toast.success(
        'On-screen controls saved',
        this.voiceSession.conversationActive()
          ? 'Hang up and restart the session to apply wake-word changes.'
          : 'Applies the next time you tap the orb.',
      );
    } catch (err) {
      this.toast.error('Could not save controls', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingTouchUi = false;
    }
  }

  protected async onTouchOnlyPreset(): Promise<void> {
    this.savingTouchUi = true;
    try {
      await this.voiceProviders.updateVoiceUi({ touchOnlyPreset: true });
      this.syncVoiceForm();
      this.toast.success('Touch-only preset', 'On-screen controls always on; wake words off.');
    } catch (err) {
      this.toast.error('Could not apply preset', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingTouchUi = false;
    }
  }

  private voiceToOption(v: SpeechSynthesisVoice): BrowserVoiceOption {
    return {
      label: `${v.name} · ${v.lang}${v.localService ? '' : ' · remote'}`,
      value: v.voiceURI,
    };
  }

  private lazyPad(index: number): BrowserVoiceOption {
    return { label: ' ', value: `__lazy_${index}`, disabled: true };
  }

  private buildBrowserVoiceSource(voices: SpeechSynthesisVoice[]): BrowserVoiceOption[] {
    const curated = curateBrowserTtsVoices(voices, {
      preferredLang: this.browserTtsLang || undefined,
      selectedVoiceURI: this.browserVoiceUri || undefined,
      includeRemote: this.browserVoicesShowAll,
      maxVoices: this.browserVoicesShowAll ? Number.POSITIVE_INFINITY : BROWSER_VOICE_CURATED_MAX,
    });
    const mapped = curated.map((v) => this.voiceToOption(v));
    return [{ label: 'System default', value: '' }, ...mapped];
  }

  private filteredBrowserVoiceSource(): BrowserVoiceOption[] {
    const q = this.browserVoiceFilter.trim().toLowerCase();
    if (!q) return this.browserVoiceSource;
    return this.browserVoiceSource.filter((opt) => opt.label.toLowerCase().includes(q));
  }

  /**
   * Bind a full-length sparse array so virtual scroll height matches the catalog,
   * and only hydrate the visible window (plus the selected row).
   */
  private fillBrowserVoiceWindow(first: number, last: number): void {
    const source = this.filteredBrowserVoiceSource();
    this.browserVoicesShown = source.length;

    if (source.length === 0) {
      this.browserVoiceOptions = [];
      this.browserVoicesLoaded = 0;
      return;
    }

    const from = Math.max(0, Math.min(first, source.length - 1));
    const to = Math.min(
      source.length,
      Math.max(last + 1, from + BROWSER_VOICE_LAZY_CHUNK, BROWSER_VOICE_LAZY_CHUNK),
    );

    const next: BrowserVoiceOption[] = new Array(source.length);
    for (let i = 0; i < source.length; i++) {
      next[i] = i >= from && i < to ? source[i]! : this.lazyPad(i);
    }

    const selected = this.browserVoiceUri;
    if (selected !== undefined && selected !== null) {
      const selectedIdx = source.findIndex((o) => o.value === selected);
      if (selectedIdx >= 0) next[selectedIdx] = source[selectedIdx]!;
    }

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

  /** Custom filter — searches the full source, then rebuilds the lazy window. */
  protected onBrowserVoiceSearch(query: string): void {
    this.browserVoiceFilter = query;
    if (this.browserVoiceSearchTimer) clearTimeout(this.browserVoiceSearchTimer);
    this.browserVoiceSearchTimer = setTimeout(() => {
      this.browserVoiceSearchTimer = null;
      this.fillBrowserVoiceWindow(0, BROWSER_VOICE_LAZY_CHUNK);
      this.cdr.markForCheck();
    }, 120);
  }

  private async loadSpeechOutputUi(): Promise<void> {
    this.browserProfiles = listBrowserTtsProfiles();
    const current = this.browserProfiles.find((p) => p.id === this.currentBrowserId);
    const opts = current?.options ?? {};
    this.browserVoiceUri = opts.voiceURI ?? '';
    this.browserTtsRate = opts.rate ?? this.webkitRate;
    this.browserTtsPitch = opts.pitch ?? this.webkitPitch;
    this.browserTtsVolume = opts.volume ?? this.webkitVolume;
    this.browserTtsLang = opts.lang ?? this.webkitLang;

    this.browserVoicesLoading = true;
    try {
      const voices = await listBrowserTtsVoicesAsync();
      this.applyBrowserVoiceOptions(voices);
    } finally {
      this.browserVoicesLoading = false;
    }

    this.unsubBrowserVoices?.();
    this.unsubBrowserVoices = onBrowserTtsVoicesChanged((voices) => {
      this.applyBrowserVoiceOptions(voices);
    });

    try {
      const res = await this.admin.getWorkflow();
      const audio = res.workflow.llmIntelligence.audio;
      this.ttsProvider = audio.ttsProvider ?? (audio.preferWebkit === false ? 'amazon_polly' : 'browser');
      this.pollyVoiceId = audio.pollyVoiceId || 'Joanna';
      this.pollyEngine = audio.pollyEngine || 'neural';
      this.applyTranscribeAudio(audio);
      if (this.workflowData) {
        this.workflowData.llmIntelligence.audio.ttsProvider = this.ttsProvider;
        this.workflowData.llmIntelligence.audio.pollyVoiceId = this.pollyVoiceId;
        this.workflowData.llmIntelligence.audio.pollyEngine = this.pollyEngine;
      }
    } catch {
      // Bridge offline — keep local defaults
    }

    if (this.ttsProvider === 'amazon_polly') {
      await this.loadPollyVoices();
    }
    this.cdr.markForCheck();
  }

  protected async onTtsProviderChange(): Promise<void> {
    if (this.ttsProvider === 'amazon_polly') {
      await this.loadPollyVoices();
    }
  }

  protected async onPollyEngineChange(): Promise<void> {
    await this.loadPollyVoices();
  }

  private async loadPollyVoices(): Promise<void> {
    if (!this.isBridgeConnected()) {
      this.pollyVoiceOptions = [];
      return;
    }
    this.loadingPollyVoices = true;
    try {
      const res = await this.admin.getPollyVoices(this.pollyEngine);
      this.pollyVoices = res.voices;
      this.pollyVoiceOptions = res.voices.map((v) => ({
        label: `${v.name} · ${v.languageName || v.languageCode}${v.gender ? ` · ${v.gender}` : ''}`,
        value: v.id,
      }));
      if (
        this.pollyVoiceId &&
        this.pollyVoiceOptions.length > 0 &&
        !this.pollyVoiceOptions.some((o) => o.value === this.pollyVoiceId)
      ) {
        // Keep custom/legacy id selectable so save still works.
        this.pollyVoiceOptions = [
          { label: `${this.pollyVoiceId} (saved)`, value: this.pollyVoiceId },
          ...this.pollyVoiceOptions,
        ];
      }
    } catch (err) {
      this.pollyVoices = [];
      this.pollyVoiceOptions = this.pollyVoiceId
        ? [{ label: `${this.pollyVoiceId} (saved — list unavailable)`, value: this.pollyVoiceId }]
        : [];
      this.toast.warn(
        'Could not load Polly voices',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.loadingPollyVoices = false;
      this.cdr.markForCheck();
    }
  }

  protected async onSaveSpeechOutput(): Promise<void> {
    this.savingSpeechOutput = true;
    try {
      if (this.ttsProvider === 'browser') {
        saveBrowserTtsProfile(this.currentBrowserId, {
          voiceURI: this.browserVoiceUri || undefined,
          rate: Number(this.browserTtsRate),
          pitch: Number(this.browserTtsPitch),
          volume: Number(this.browserTtsVolume),
          lang: this.browserTtsLang.trim() || 'en-US',
        });
        this.browserProfiles = listBrowserTtsProfiles();
        this.voiceSession.refreshBrowserTtsOptions();
      }

      const res = await this.admin.patchWorkflow({
        llmIntelligence: {
          audio: {
            ttsProvider: this.ttsProvider,
            pollyVoiceId: this.pollyVoiceId.trim() || 'Joanna',
            pollyEngine: this.pollyEngine,
          },
        },
      } as Partial<WorkflowSettings>);
      this.workflowData = structuredClone(res.workflow);
      this.ttsProvider = res.workflow.llmIntelligence.audio.ttsProvider ?? this.ttsProvider;
      this.pollyVoiceId = res.workflow.llmIntelligence.audio.pollyVoiceId;
      this.pollyEngine = res.workflow.llmIntelligence.audio.pollyEngine;

      this.toast.success(
        'Speech output saved',
        this.voiceSession.conversationActive()
          ? 'Restart the voice session to apply the new TTS provider.'
          : this.ttsProvider === 'browser'
            ? `Browser voice profile saved for ${this.currentBrowserLabel}.`
            : `Amazon Polly voice: ${this.pollyVoiceId}.`,
      );
    } catch (err) {
      this.toast.error('Could not save speech output', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingSpeechOutput = false;
    }
  }

  private applyTranscribeAudio(audio: WorkflowSettings['llmIntelligence']['audio']): void {
    this.transcribeModel = audio.transcribeModel ?? 'speech_foundation_model';
    this.transcribeLanguageMode = audio.transcribeLanguageMode ?? 'fixed';
    this.transcribeLanguageCode = audio.transcribeLanguageCode || 'en-US';
    this.transcribeLanguageOptions =
      audio.transcribeLanguageOptions || 'en-US,es-US,fr-FR,de-DE';
    this.transcribePreferredLanguage =
      audio.transcribePreferredLanguage || audio.transcribeLanguageCode || 'en-US';
    this.transcribePartialResultsStabilization =
      audio.transcribePartialResultsStabilization !== false;
    this.transcribePartialResultsStability =
      audio.transcribePartialResultsStability ?? 'high';
  }

  protected async onSaveSpeechInput(): Promise<void> {
    this.savingSpeechInput = true;
    try {
      const res = await this.admin.patchWorkflow({
        llmIntelligence: {
          audio: {
            transcribeModel: this.transcribeModel,
            transcribeLanguageMode: this.transcribeLanguageMode,
            transcribeLanguageCode: this.transcribeLanguageCode.trim() || 'en-US',
            transcribeLanguageOptions: this.transcribeLanguageOptions.trim() || 'en-US',
            transcribePreferredLanguage: this.transcribePreferredLanguage.trim() || 'en-US',
            transcribePartialResultsStabilization: this.transcribePartialResultsStabilization,
            transcribePartialResultsStability: this.transcribePartialResultsStability,
          },
        },
      } as Partial<WorkflowSettings>);
      this.workflowData = structuredClone(res.workflow);
      this.applyTranscribeAudio(res.workflow.llmIntelligence.audio);
      this.toast.success(
        'Speech input saved',
        this.transcribeLanguageMode === 'fixed'
          ? `Transcribe SFM · ${this.transcribeLanguageCode} · stability ${this.transcribePartialResultsStability}`
          : `Transcribe SFM · auto-identify · stability ${this.transcribePartialResultsStability}`,
      );
    } catch (err) {
      this.toast.error('Could not save speech input', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingSpeechInput = false;
    }
  }

  protected async onPreviewPollyVoice(): Promise<void> {
    if (!this.isBridgeConnected()) {
      this.toast.warn('Not connected', 'Connect to the bridge to preview Polly.');
      return;
    }
    this.previewingPolly = true;
    try {
      await speakAmazonPolly(
        `This is the Amazon Polly voice ${this.pollyVoiceId}.`,
        this.bridge.bridgeBase,
        this.bridge.appToken,
        undefined,
        { voiceId: this.pollyVoiceId, engine: this.pollyEngine },
      );
    } catch (err) {
      this.toast.error('Polly preview failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.previewingPolly = false;
    }
  }

  protected async onSaveTtsSettings(): Promise<void> {
    this.savingTts = true;
    try {
      await this.voiceProviders.updateVoiceTts({
        cursorVoiceEnabled: this.cursorVoiceEnabled,
        errorSoundEnabled: this.errorSoundEnabled,
        errorSpeakEnabled: this.errorSpeakEnabled,
        webkit: {
          rate: Number(this.webkitRate),
          pitch: Number(this.webkitPitch),
          volume: Number(this.webkitVolume),
          lang: this.webkitLang.trim() || 'en-US',
        },
      });
      this.syncVoiceForm();
      this.toast.success(
        'TTS settings saved',
        this.voiceSession.conversationActive()
          ? 'Restart the voice session to apply server defaults.'
          : 'Settings apply the next time you tap the orb.',
      );
    } catch (err) {
      this.toast.error('Could not save TTS settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingTts = false;
    }
  }

  protected onSaveBrowserTtsProfile(): void {
    saveBrowserTtsProfile(this.currentBrowserId, {
      voiceURI: this.browserVoiceUri || undefined,
      rate: Number(this.browserTtsRate),
      pitch: Number(this.browserTtsPitch),
      volume: Number(this.browserTtsVolume),
      lang: this.browserTtsLang.trim() || 'en-US',
    });
    this.browserProfiles = listBrowserTtsProfiles();
    this.voiceSession.refreshBrowserTtsOptions();
    this.toast.success('Browser TTS saved', this.currentBrowserLabel);
  }

  protected onLoadBrowserProfile(profile: BrowserTtsProfile): void {
    this.browserVoiceUri = profile.options.voiceURI ?? '';
    this.browserTtsRate = profile.options.rate ?? this.webkitRate;
    this.browserTtsPitch = profile.options.pitch ?? this.webkitPitch;
    this.browserTtsVolume = profile.options.volume ?? this.webkitVolume;
    this.browserTtsLang = profile.options.lang ?? this.webkitLang;
    this.ttsProvider = 'browser';
  }

  protected onDeleteBrowserProfile(id: string): void {
    deleteBrowserTtsProfile(id);
    this.browserProfiles = listBrowserTtsProfiles();
    this.toast.success('Profile removed');
  }

  protected onPreviewBrowserTts(): void {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      this.toast.warn('Browser TTS unavailable', 'speechSynthesis is not supported here.');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance('This is how AgentVoice will sound on this browser.');
    utter.rate = Number(this.browserTtsRate) || 1;
    utter.pitch = Number(this.browserTtsPitch) || 1;
    utter.volume = Number(this.browserTtsVolume) || 1;
    utter.lang = this.browserTtsLang.trim() || 'en-US';
    if (this.browserVoiceUri) {
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === this.browserVoiceUri);
      if (voice) utter.voice = voice;
    }
    window.speechSynthesis.speak(utter);
  }

  // ── Personal section ─────────────────────────────────────────────────────

  protected userName = '';
  protected savingUserName = false;

  protected async onSaveUserName(): Promise<void> {
    this.savingUserName = true;
    try {
      await this.voiceProviders.updateUserName(this.userName.trim() || null);
      this.syncVoiceForm();
      this.toast.success('Name saved', 'The agent will address you by name.');
    } catch (err) {
      this.toast.error('Could not save name', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingUserName = false;
    }
  }

  // ── Projects section ─────────────────────────────────────────────────────

  protected projects: AdminProject[] = [];
  protected loadingProjects = false;
  private projectsLoadSeq = 0;
  protected pingingProject: string | null = null;

  protected showAddProject = false;
  protected addProject = { name: '', path: '', description: '', aliases: '', enabled: true };
  protected savingProject = false;

  protected editingProject: AdminProject | null = null;
  protected editProject = { path: '', description: '', aliases: '', enabled: true };
  protected savingEditProject = false;

  private async loadProjects(): Promise<void> {
    const seq = ++this.projectsLoadSeq;
    this.loadingProjects = true;
    try {
      const res = await this.admin.getAdminProjects();
      if (seq !== this.projectsLoadSeq) return;
      this.projects = res.projects;
    } catch (err) {
      if (seq !== this.projectsLoadSeq) return;
      this.toast.error('Could not load projects', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.projectsLoadSeq) {
        this.loadingProjects = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected openAddProject(): void {
    this.showAddProject = true;
    this.addProject = { name: '', path: '', description: '', aliases: '', enabled: true };
  }

  protected cancelAddProject(): void {
    this.showAddProject = false;
  }

  protected async onAddProject(): Promise<void> {
    const name = this.addProject.name.trim();
    const path = this.addProject.path.trim();
    if (!name || !path) {
      this.toast.warn('Missing fields', 'Name and path are required.');
      return;
    }
    this.savingProject = true;
    try {
      const aliases = this.addProject.aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      await this.admin.createProject({
        name,
        path,
        description: this.addProject.description.trim() || undefined,
        aliases,
        enabled: this.addProject.enabled,
      });
      this.showAddProject = false;
      this.toast.success('Project added', name);
      await this.loadProjects();
    } catch (err) {
      this.toast.error('Could not add project', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingProject = false;
    }
  }

  protected startEditProject(p: AdminProject): void {
    this.editingProject = p;
    this.editProject = {
      path: p.path,
      description: p.description ?? '',
      aliases: p.aliases.join(', '),
      enabled: p.enabled,
    };
  }

  protected cancelEditProject(): void {
    this.editingProject = null;
  }

  protected async onSaveEditProject(): Promise<void> {
    if (!this.editingProject) return;
    this.savingEditProject = true;
    try {
      const aliases = this.editProject.aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      await this.admin.updateProject(this.editingProject.name, {
        path: this.editProject.path.trim(),
        description: this.editProject.description.trim() || null,
        aliases,
        enabled: this.editProject.enabled,
      });
      this.editingProject = null;
      this.toast.success('Project saved');
      await this.loadProjects();
    } catch (err) {
      this.toast.error('Could not save project', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingEditProject = false;
    }
  }

  protected async onDeleteProject(name: string): Promise<void> {
    try {
      await this.admin.deleteProject(name);
      this.toast.success('Project removed', name);
      await this.loadProjects();
    } catch (err) {
      this.toast.error('Could not remove project', err instanceof Error ? err.message : String(err));
    }
  }

  protected async onPingProject(name: string): Promise<void> {
    this.pingingProject = name;
    try {
      const res = await this.admin.pingProject(name);
      if (res.exists) {
        this.toast.success('Path exists', res.path);
      } else {
        this.toast.warn('Path not found', res.path);
      }
      await this.loadProjects();
    } catch (err) {
      this.toast.error('Ping failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.pingingProject = null;
    }
  }

  // ── Keys section ─────────────────────────────────────────────────────────

  protected keyStatus: AwsKeyStatus[] = [];
  protected keysViable = false;
  protected loadingKeys = false;
  private keysLoadSeq = 0;
  protected testingKeys = false;
  protected keyTestResult: { ok: boolean; latencyMs: number; error?: string } | null = null;

  protected keyEdits: Record<string, string> = {};
  protected savingKeys = false;

  private async loadKeys(): Promise<void> {
    const seq = ++this.keysLoadSeq;
    this.loadingKeys = true;
    try {
      const res = await this.admin.getKeys();
      if (seq !== this.keysLoadSeq) return;
      this.keyStatus = res.keys;
      this.keysViable = res.viable;
      this.keyEdits = {};
    } catch (err) {
      if (seq !== this.keysLoadSeq) return;
      this.toast.error('Could not load key status', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.keysLoadSeq) {
        this.loadingKeys = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected async onSaveKeys(): Promise<void> {
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.keyEdits)) {
      if (v.trim()) updates[k] = v.trim();
    }
    if (Object.keys(updates).length === 0) {
      this.toast.warn('Nothing to save', 'Enter at least one key value.');
      return;
    }
    this.savingKeys = true;
    try {
      const res = await this.admin.patchKeys(updates);
      this.keyStatus = res.keys;
      this.keysViable = res.viable;
      this.keyEdits = {};
      this.toast.success('Keys saved', 'Credentials updated in .env file.');
    } catch (err) {
      this.toast.error('Could not save keys', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingKeys = false;
    }
  }

  protected async onTestKeys(): Promise<void> {
    this.testingKeys = true;
    this.keyTestResult = null;
    try {
      this.keyTestResult = await this.admin.testKeys();
      if (this.keyTestResult.ok) {
        this.toast.success('Credentials valid', `STS ping: ${this.keyTestResult.latencyMs} ms`);
      } else {
        this.toast.warn('Credentials invalid', this.keyTestResult.error ?? 'Unknown error');
      }
    } catch (err) {
      this.keyTestResult = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.testingKeys = false;
    }
  }

  // ── Workflow section ─────────────────────────────────────────────────────

  protected workflowData: WorkflowSettings | null = null;
  protected loadingWorkflow = false;
  private workflowLoadSeq = 0;
  protected savingWorkflow = false;

  private async loadWorkflow(): Promise<void> {
    const seq = ++this.workflowLoadSeq;
    this.loadingWorkflow = true;
    try {
      const res = await this.admin.getWorkflow();
      if (seq !== this.workflowLoadSeq) return;
      this.workflowData = structuredClone(res.workflow);
      const audio = this.workflowData.llmIntelligence.audio;
      if (!audio.ttsProvider) {
        audio.ttsProvider = audio.preferWebkit === false ? 'amazon_polly' : 'browser';
      }
      if (!audio.transcribeModel) audio.transcribeModel = 'speech_foundation_model';
      if (!audio.transcribeLanguageMode) audio.transcribeLanguageMode = 'fixed';
      if (audio.transcribePartialResultsStabilization === undefined) {
        audio.transcribePartialResultsStabilization = true;
      }
      if (!audio.transcribePartialResultsStability) {
        audio.transcribePartialResultsStability = 'high';
      }
      if (!audio.transcribeLanguageOptions) {
        audio.transcribeLanguageOptions = 'en-US,es-US,fr-FR,de-DE';
      }
      this.ttsProvider = audio.ttsProvider;
      this.pollyVoiceId = audio.pollyVoiceId;
      this.pollyEngine = audio.pollyEngine;
      this.applyTranscribeAudio(audio);
    } catch (err) {
      if (seq !== this.workflowLoadSeq) return;
      this.toast.error('Could not load workflow settings', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.workflowLoadSeq) {
        this.loadingWorkflow = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected async onSaveWorkflow(): Promise<void> {
    if (!this.workflowData) return;
    this.savingWorkflow = true;
    try {
      const res = await this.admin.patchWorkflow(this.workflowData);
      this.workflowData = structuredClone(res.workflow);
      this.toast.success('Workflow settings saved');
    } catch (err) {
      this.toast.error('Could not save workflow settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingWorkflow = false;
    }
  }

  // ── Agent Client section ─────────────────────────────────────────────────

  protected agentClientData: AgentClientSettings | null = null;
  protected loadingAgentClient = false;
  private agentClientLoadSeq = 0;
  protected savingAgentClient = false;

  private async loadAgentClient(): Promise<void> {
    const seq = ++this.agentClientLoadSeq;
    this.loadingAgentClient = true;
    try {
      const data = await this.admin.getAgentClient();
      if (seq !== this.agentClientLoadSeq) return;
      this.agentClientData = data;
    } catch (err) {
      if (seq !== this.agentClientLoadSeq) return;
      this.toast.error('Could not load agent client', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.agentClientLoadSeq) {
        this.loadingAgentClient = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected async onSelectAgentClient(clientId: AgentClientId): Promise<void> {
    if (!this.agentClientData || this.agentClientData.active === clientId) return;
    this.savingAgentClient = true;
    try {
      const res = await this.admin.setAgentClient(clientId);
      this.agentClientData = { active: res.active, clients: res.clients };
      this.toast.success('Agent client changed', res.clients.find((c) => c.id === res.active)?.label ?? res.active);
    } catch (err) {
      this.toast.error('Could not change agent client', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingAgentClient = false;
    }
  }

  // ── Serve hub ─────────────────────────────────────────────────────────────

  protected serveTab = signal<ServeTabId>('status');
  protected serveData: ServeSettings | null = null;
  protected serveStatus: ServeStatus | null = null;
  protected serveEvents: ServeEvent[] = [];
  protected hostingData: HostingSettings | null = null;
  protected loadingServe = false;
  private serveLoadSeq = 0;
  protected savingServe = false;
  protected savingHosting = false;
  protected serveBranch = '';
  protected serveRepoDir = '';
  protected pingResult: { ok: boolean; latencyMs: number; error?: string } | null = null;
  protected pingingHealth = false;
  protected runningPull = false;
  protected runningRestart = false;
  protected runningHealth = false;
  protected readonly journalEl = viewChild<ElementRef<HTMLPreElement>>('journalEl');
  protected journalLines: string[] = [];
  protected journalLive = false;
  protected journalError: string | null = null;
  protected journalUnit = 'agentvoice.service';
  private journalAbort: AbortController | null = null;
  private journalPollTimer: ReturnType<typeof setTimeout> | null = null;

  protected get journalText(): string {
    return this.journalLines.join('\n');
  }

  protected get serveTrackBranch(): string {
    return (
      this.serveBranch.trim() ||
      this.serveStatus?.git?.trackBranch ||
      this.serveStatus?.git?.defaultBranch ||
      'main'
    );
  }

  protected get serveBranchPlaceholder(): string {
    return this.serveStatus?.git?.defaultBranch || 'main';
  }

  protected async loadServe(): Promise<void> {
    const seq = ++this.serveLoadSeq;
    this.loadingServe = true;
    try {
      const [serveRes, events, hosting] = await Promise.all([
        this.admin.getServe(),
        this.admin.getServeEvents(40),
        this.admin.getHosting(),
      ]);
      if (seq !== this.serveLoadSeq) return;
      this.serveData = structuredClone(serveRes.serve);
      this.serveStatus = serveRes.status;
      this.serveEvents = events.entries;
      this.serveBranch = serveRes.serve.branch ?? '';
      this.serveRepoDir = serveRes.serve.repoDir ?? '';
      this.hostingData = hosting;
    } catch (err) {
      if (seq !== this.serveLoadSeq) return;
      this.toast.error('Could not load serve settings', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.serveLoadSeq) {
        this.loadingServe = false;
        this.cdr.markForCheck();
      }
    }
    void this.loadHostingProviders();
    if (this.serveTab() === 'logs' && !this.journalAbort) this.startJournalStream();
  }

  protected onServeTabChange(tab: ServeTabId): void {
    this.serveTab.set(tab);
    if (tab === 'logs') this.startJournalStream();
    else this.stopJournalStream();
  }

  private startJournalStream(): void {
    this.stopJournalStream();
    const ac = new AbortController();
    this.journalAbort = ac;
    this.journalLines = [];
    this.journalError = null;
    this.journalLive = true;
    this.cdr.markForCheck();

    void this.admin
      .streamServeLogs(
        (event) => {
          if (ac.signal.aborted) return;
          if (event.type === 'log' && event.line) this.appendJournalLine(event.line);
          if (event.type === 'meta' && event.unit) this.journalUnit = event.unit;
          if (event.type === 'error') this.journalError = event.detail ?? 'journal error';
          if (event.type === 'end') this.journalLive = false;
          this.cdr.markForCheck();
          this.scrollJournal();
        },
        ac.signal,
      )
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        this.journalError = err instanceof Error ? err.message : String(err);
        this.cdr.markForCheck();
      })
      .then(() => {
        if (ac.signal.aborted) return;
        this.journalLive = false;
        this.cdr.markForCheck();
        this.startJournalPoll(ac.signal);
      });
  }

  private startJournalPoll(signal: AbortSignal): void {
    const poll = async (): Promise<void> => {
      if (signal.aborted) return;
      try {
        const logs = await this.admin.getServeLogs(120);
        if (signal.aborted) return;
        this.journalLines = logs.text ? logs.text.split('\n') : [];
        this.journalError = logs.ok ? null : (logs.detail ?? 'journalctl failed');
        this.journalLive = logs.ok;
        this.cdr.markForCheck();
        this.scrollJournal();
      } catch (err) {
        if (signal.aborted) return;
        this.journalError = err instanceof Error ? err.message : String(err);
        this.journalLive = false;
        this.cdr.markForCheck();
      }
      if (!signal.aborted) {
        this.journalPollTimer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
  }

  private appendJournalLine(line: string): void {
    this.journalLines = [...this.journalLines, line];
    if (this.journalLines.length > 500) {
      this.journalLines = this.journalLines.slice(-500);
    }
  }

  private scrollJournal(): void {
    const el = this.journalEl()?.nativeElement;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  private stopJournalStream(): void {
    this.journalAbort?.abort();
    this.journalAbort = null;
    if (this.journalPollTimer) {
      clearTimeout(this.journalPollTimer);
      this.journalPollTimer = null;
    }
    this.journalLive = false;
  }

  protected async onSaveServe(): Promise<void> {
    this.savingServe = true;
    try {
      const patch: Partial<ServeSettings> = {
        branch: this.serveBranch.trim(),
        repoDir: this.serveRepoDir.trim(),
      };
      const res = await this.admin.patchServe(patch);
      this.serveData = structuredClone(res.serve);
      this.serveStatus = res.status;
      this.serveBranch = res.serve.branch ?? '';
      this.serveRepoDir = res.serve.repoDir ?? '';
      this.toast.success('Serve settings saved');
    } catch (err) {
      this.toast.error('Could not save serve settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingServe = false;
    }
  }

  protected async onSaveHosting(): Promise<void> {
    if (!this.hostingData) return;
    this.savingHosting = true;
    try {
      const res = await this.admin.patchHosting(this.hostingData);
      this.hostingData = { runMode: res.runMode, runModes: res.runModes };
      this.toast.success('Network settings saved', 'Restart the bridge to apply port changes.');
    } catch (err) {
      this.toast.error('Could not save network settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingHosting = false;
    }
  }

  // ── Hosting provider (pluggable tunnel/proxy) ────────────────────────────

  protected hostingProviders: HostingProviderInfo[] = [];
  protected detectedHostingProviderId: HostingProviderId | null = null;
  protected selectedHostingProviderId: HostingProviderId = 'tailscale';
  protected hostingHostnameInput = '';
  protected hostingLoginServerInput = '';
  protected settingUpHosting = false;
  protected hostingSetupLog: string[] = [];
  protected hostingSetupError: string | null = null;
  protected hostingSetupPublicUrl: string | null = null;
  private hostingSetupRunId: string | null = null;
  private hostingSetupPollTimer: ReturnType<typeof setTimeout> | null = null;
  private hostingProgressSub: Subscription | null = null;
  protected hostingDoctorResults: HostingDoctorResult[] = [];
  protected runningHostingDoctor = false;
  protected clearingHostingOverride = false;

  protected readonly hostingProviderOptions = HOSTING_PROVIDER_ORDER.map((id) => ({ id }));

  protected hostingProviderInfo(id: HostingProviderId): HostingProviderInfo | null {
    return this.hostingProviders.find((p) => p.id === id) ?? null;
  }

  protected hostingProviderLabel(id: HostingProviderId): string {
    return this.hostingProviderInfo(id)?.displayName ?? id;
  }

  protected get selectedHostnameField(): HostnameFieldMeta | null {
    return HOSTING_HOSTNAME_FIELD[this.selectedHostingProviderId] ?? null;
  }

  protected get selectedLoginServerField(): HostnameFieldMeta | null {
    return HOSTING_LOGIN_SERVER_FIELD[this.selectedHostingProviderId] ?? null;
  }

  private async loadHostingProviders(): Promise<void> {
    try {
      const res = await this.admin.getHostingProviders();
      this.hostingProviders = HOSTING_PROVIDER_ORDER.map((id) =>
        res.providers.find((p) => p.id === id),
      ).filter((p): p is HostingProviderInfo => !!p);
      this.detectedHostingProviderId = res.active;
      // Pre-select the currently active provider (Hick's Law — don't force a re-decision).
      if (!this.hostingHostnameInput && !this.settingUpHosting) {
        this.selectedHostingProviderId = res.active;
      }
      this.cdr.markForCheck();
    } catch (err) {
      this.toast.error('Could not load hosting providers', err instanceof Error ? err.message : String(err));
    }
  }

  protected onSelectHostingProvider(id: HostingProviderId): void {
    this.selectedHostingProviderId = id;
    this.hostingHostnameInput = '';
    this.hostingLoginServerInput = '';
    this.hostingSetupLog = [];
    this.hostingSetupError = null;
    this.hostingSetupPublicUrl = null;
    this.hostingDoctorResults = [];
  }

  protected async onRunHostingSetup(): Promise<void> {
    const field = this.selectedHostnameField;
    if (field?.required && !this.hostingHostnameInput.trim()) {
      this.toast.warn('Missing field', `${field.label} is required for this provider.`);
      return;
    }
    this.settingUpHosting = true;
    this.hostingSetupLog = [];
    this.hostingSetupError = null;
    this.hostingSetupPublicUrl = null;
    try {
      const { runId } = await this.admin.startHostingSetup(this.selectedHostingProviderId, {
        hostname: this.hostingHostnameInput.trim() || undefined,
        loginServer: this.hostingLoginServerInput.trim() || undefined,
      });
      this.hostingSetupRunId = runId;
      this.subscribeToHostingProgress(runId);
      this.pollHostingSetupRun(runId);
    } catch (err) {
      this.settingUpHosting = false;
      this.hostingSetupError = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not start setup', this.hostingSetupError);
    }
  }

  private subscribeToHostingProgress(runId: string): void {
    this.hostingProgressSub?.unsubscribe();
    this.hostingProgressSub = this.bridge.hostingSetupProgress$.subscribe((event) => {
      if (event.runId !== runId) return;
      if (event.message) this.hostingSetupLog = [...this.hostingSetupLog, event.message];
      if (event.error) this.hostingSetupError = event.error;
      if (event.result?.publicUrl) this.hostingSetupPublicUrl = event.result.publicUrl;
      if (event.done) this.finishHostingSetup(runId, event.result?.ok !== false);
      this.cdr.markForCheck();
    });
  }

  /** WS-disconnect-safe fallback — polls until the run is marked done. */
  private pollHostingSetupRun(runId: string): void {
    if (this.hostingSetupPollTimer) clearTimeout(this.hostingSetupPollTimer);
    const poll = async () => {
      if (this.hostingSetupRunId !== runId) return;
      try {
        const status = await this.admin.getHostingSetupRun(runId);
        const seenMessages = new Set(this.hostingSetupLog);
        for (const event of status.events) {
          if (event.message && !seenMessages.has(event.message)) {
            this.hostingSetupLog = [...this.hostingSetupLog, event.message];
            seenMessages.add(event.message);
          }
          if (event.error) this.hostingSetupError = event.error;
        }
        if (status.result?.publicUrl) this.hostingSetupPublicUrl = status.result.publicUrl;
        this.cdr.markForCheck();
        if (status.done) {
          this.finishHostingSetup(runId, status.result?.ok !== false);
          return;
        }
      } catch {
        // Transient — keep polling until the run resolves or the component is destroyed.
      }
      this.hostingSetupPollTimer = setTimeout(() => void poll(), 1500);
    };
    this.hostingSetupPollTimer = setTimeout(() => void poll(), 1500);
  }

  private finishHostingSetup(runId: string, ok: boolean): void {
    if (this.hostingSetupRunId !== runId) return;
    this.settingUpHosting = false;
    this.hostingSetupRunId = null;
    if (this.hostingSetupPollTimer) {
      clearTimeout(this.hostingSetupPollTimer);
      this.hostingSetupPollTimer = null;
    }
    this.hostingProgressSub?.unsubscribe();
    this.hostingProgressSub = null;
    if (ok) {
      this.toast.success('Hosting setup complete', this.hostingSetupPublicUrl ?? undefined);
    } else {
      this.toast.warn('Hosting setup finished with issues', this.hostingSetupError ?? undefined);
    }
    void this.loadHostingProviders();
    this.cdr.markForCheck();
  }

  protected async onClearHostingOverride(): Promise<void> {
    this.clearingHostingOverride = true;
    try {
      const res = await this.admin.setActiveHostingProvider(null);
      this.detectedHostingProviderId = res.active;
      this.toast.success('Back to auto-detect', `Now using ${this.hostingProviderLabel(res.active)}`);
      await this.loadHostingProviders();
    } catch (err) {
      this.toast.error('Could not clear override', err instanceof Error ? err.message : String(err));
    } finally {
      this.clearingHostingOverride = false;
    }
  }

  protected async onRunHostingDoctor(): Promise<void> {
    this.runningHostingDoctor = true;
    this.hostingDoctorResults = [];
    try {
      const res = await this.admin.getHostingDoctor(this.selectedHostingProviderId);
      this.hostingDoctorResults = [res as HostingDoctorResult];
    } catch (err) {
      this.toast.error('Doctor check failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.runningHostingDoctor = false;
      this.cdr.markForCheck();
    }
  }

  protected hostingDetectSeverity(active: boolean, installed: boolean): 'success' | 'warn' | 'secondary' {
    if (active) return 'success';
    if (!installed) return 'secondary';
    return 'warn';
  }

  protected async onServeAction(action: ServeActionId): Promise<void> {
    const setLoading = (v: boolean): void => {
      switch (action) {
        case 'pull':
          this.runningPull = v;
          break;
        case 'restart':
          this.runningRestart = v;
          break;
        case 'health':
          this.runningHealth = v;
          break;
      }
    };
    setLoading(true);
    try {
      if (action === 'pull') {
        await this.admin.patchServe({
          branch: this.serveBranch.trim(),
          repoDir: this.serveRepoDir.trim(),
        });
      }
      const res = await this.admin.serveAction(action);
      this.serveStatus = res.status;
      if (res.outcome === 'error') {
        this.toast.warn('Action completed with issues', res.detail);
      } else {
        this.toast.success('Action completed', res.detail);
      }
      await this.loadServe();
    } catch (err) {
      this.toast.error('Action failed', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  protected async onPingHealth(): Promise<void> {
    this.pingingHealth = true;
    this.pingResult = null;
    try {
      this.pingResult = await this.admin.pingHealth();
      if (this.pingResult.ok) {
        this.toast.success('Health check passed', `${this.pingResult.latencyMs} ms`);
      } else {
        this.toast.warn('Health check failed', this.pingResult.error ?? 'No response');
      }
    } finally {
      this.pingingHealth = false;
    }
  }

  protected get serveBusy(): boolean {
    return (
      this.runningPull ||
      this.runningRestart ||
      this.runningHealth ||
      (this.serveStatus?.running ?? false)
    );
  }

  protected serveStatusSeverity(
    outcome: string | undefined,
  ): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    switch (outcome) {
      case 'ok':
        return 'success';
      case 'no_changes':
      case 'skipped':
        return 'info';
      case 'error':
        return 'danger';
      default:
        return 'secondary';
    }
  }

  protected eventStatusSeverity(
    status: string,
  ): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    switch (status) {
      case 'ok':
        return 'success';
      case 'warn':
        return 'warn';
      case 'error':
        return 'danger';
      case 'skip':
        return 'info';
      default:
        return 'secondary';
    }
  }

  // ── Jobs section ─────────────────────────────────────────────────────────

  protected jobsData: JobSettings | null = null;
  protected loadingJobs = false;
  private jobsLoadSeq = 0;
  protected savingJobs = false;
  protected newPreRunFlag = '';

  private async loadJobs(): Promise<void> {
    const seq = ++this.jobsLoadSeq;
    this.loadingJobs = true;
    try {
      const data = await this.admin.getJobs();
      if (seq !== this.jobsLoadSeq) return;
      this.jobsData = data;
    } catch (err) {
      if (seq !== this.jobsLoadSeq) return;
      this.toast.error('Could not load job settings', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.jobsLoadSeq) {
        this.loadingJobs = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected onAddFlag(): void {
    if (!this.jobsData || !this.newPreRunFlag.trim()) return;
    if (!this.jobsData.preRunFlags.includes(this.newPreRunFlag.trim())) {
      this.jobsData.preRunFlags = [...this.jobsData.preRunFlags, this.newPreRunFlag.trim()];
    }
    this.newPreRunFlag = '';
  }

  protected onRemoveFlag(flag: string): void {
    if (!this.jobsData) return;
    this.jobsData.preRunFlags = this.jobsData.preRunFlags.filter((f) => f !== flag);
  }

  protected async onSaveJobs(): Promise<void> {
    if (!this.jobsData) return;
    this.savingJobs = true;
    try {
      const res = await this.admin.patchJobs(this.jobsData);
      this.jobsData = { ...res };
      this.toast.success('Job settings saved');
    } catch (err) {
      this.toast.error('Could not save job settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingJobs = false;
    }
  }

  // ── Narrator section ─────────────────────────────────────────────────────

  protected narratorData: NarratorSettings | null = null;
  protected loadingNarrator = false;
  private narratorLoadSeq = 0;
  protected savingNarrator = false;

  private async loadNarrator(): Promise<void> {
    const seq = ++this.narratorLoadSeq;
    this.loadingNarrator = true;
    try {
      const data = await this.admin.getNarrator();
      if (seq !== this.narratorLoadSeq) return;
      this.narratorData = data;
    } catch (err) {
      if (seq !== this.narratorLoadSeq) return;
      this.toast.error('Could not load narrator settings', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.narratorLoadSeq) {
        this.loadingNarrator = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected async onSaveNarrator(): Promise<void> {
    if (!this.narratorData) return;
    this.savingNarrator = true;
    try {
      const res = await this.admin.patchNarrator(this.narratorData);
      this.narratorData = { ...res };
      this.toast.success('Narrator settings saved');
    } catch (err) {
      this.toast.error('Could not save narrator settings', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingNarrator = false;
    }
  }

  // ── Database section ─────────────────────────────────────────────────────

  protected dbStats: DbStats | null = null;
  protected auditEntries: AuditEntry[] = [];
  protected loadingDb = false;
  private dbLoadSeq = 0;
  protected clearingSessions = false;

  private async loadDatabase(): Promise<void> {
    const seq = ++this.dbLoadSeq;
    this.loadingDb = true;
    try {
      const [stats, audit] = await Promise.all([
        this.admin.getDbStats(),
        this.admin.getAuditLog(30),
      ]);
      if (seq !== this.dbLoadSeq) return;
      this.dbStats = stats;
      this.auditEntries = audit.entries;
    } catch (err) {
      if (seq !== this.dbLoadSeq) return;
      this.toast.error('Could not load database info', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === this.dbLoadSeq) {
        this.loadingDb = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected async onClearSessions(): Promise<void> {
    this.clearingSessions = true;
    try {
      const res = await this.admin.clearSessions();
      this.toast.success('Sessions cleared', `${res.cleared} row(s) removed.`);
      await this.loadDatabase();
    } catch (err) {
      this.toast.error('Could not clear sessions', err instanceof Error ? err.message : String(err));
    } finally {
      this.clearingSessions = false;
    }
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // ── Debug section ────────────────────────────────────────────────────────

  protected rawJson = '';
  protected rawJsonDirty = false;
  protected loadingJson = false;
  private jsonLoadSeq = 0;
  protected savingJson = false;
  protected jsonLoadError: string | null = null;

  protected async loadRawJson(): Promise<void> {
    if (!this.canUseApi()) {
      this.jsonLoadError = 'Save your app token in Connection before loading config.json.';
      return;
    }
    const seq = ++this.jsonLoadSeq;
    this.loadingJson = true;
    this.jsonLoadError = null;
    try {
      const config = await this.bridge.loadConfigFile();
      if (seq !== this.jsonLoadSeq) return;
      this.rawJson = JSON.stringify(config, null, 2);
      this.rawJsonDirty = false;
    } catch (err) {
      if (seq !== this.jsonLoadSeq) return;
      const detail = err instanceof Error ? err.message : String(err);
      this.jsonLoadError = detail;
      this.toast.error('Could not load config.json', detail);
    } finally {
      if (seq === this.jsonLoadSeq) {
        this.loadingJson = false;
        this.cdr.markForCheck();
      }
    }
  }

  protected onRawJsonEdit(): void {
    this.rawJsonDirty = true;
  }

  protected async onSaveRawJson(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.rawJson);
    } catch {
      this.toast.warn('Invalid JSON', 'Fix syntax errors before saving.');
      return;
    }
    this.savingJson = true;
    try {
      await this.bridge.saveConfigFile(parsed);
      await this.voiceProviders.refresh();
      this.syncVoiceForm();
      this.rawJsonDirty = false;
      this.toast.success('config.json saved', 'Reload voice session to pick up changes.');
    } catch (err) {
      this.toast.error('Could not save config.json', err instanceof Error ? err.message : String(err));
    } finally {
      this.savingJson = false;
    }
  }

  protected formatRawJson(): void {
    try {
      const parsed = JSON.parse(this.rawJson);
      this.rawJson = JSON.stringify(parsed, null, 2);
      this.rawJsonDirty = true;
    } catch {
      this.toast.warn('Invalid JSON', 'Cannot format until syntax is valid.');
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  protected keySeverity(key: AwsKeyStatus): 'success' | 'warn' | 'secondary' {
    if (key.optional && !key.configured) return 'secondary';
    if (key.complete) return 'success';
    return 'warn';
  }

  protected keyStatusLabel(key: AwsKeyStatus): string {
    if (key.optional && !key.configured) return 'Optional — not set';
    if (key.complete) return key.secret ? 'Set ••••••••' : 'Set';
    if (key.configured) return 'Too short';
    return 'Not set';
  }

  protected get dbTableEntries(): Array<{ table: string; rows: number }> {
    if (!this.dbStats) return [];
    return Object.entries(this.dbStats.counts).map(([table, rows]) => ({ table, rows }));
  }
}
