/**
 * The config surface the editor exposes, as data.
 *
 * Each field names a dotted path into config.json. The webview renders from
 * this and writes back by path, so adding a setting is one entry here rather
 * than markup plus a handler plus a save branch.
 *
 * Only bridge-level enums are listed inline (run mode, log level, workflow) —
 * these belong to the bridge, not to any one CLI. Anything per-provider (the
 * agent client list, models, permission modes) is marked `optionsFrom` and
 * filled at runtime from the bridge, never hardcoded here (docs/24).
 */

export type FieldType = 'text' | 'number' | 'boolean' | 'select' | 'list';

export interface Field {
  /** Dotted path into the config file, e.g. `settings.voice.wakeWords.start`. */
  path: string;
  label: string;
  type: FieldType;
  hint?: string;
  options?: string[];
  /** Runtime-sourced options: the host fills these before rendering. */
  optionsFrom?: 'agentClients';
  min?: number;
  max?: number;
  /** Shown as a unit suffix after the input. */
  unit?: string;
}

export interface Section {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  fields: Field[];
}

export const SECTIONS: Section[] = [
  {
    id: 'agent',
    title: 'Agent',
    blurb: 'Which coding CLI runs, and how each turn starts',
    icon: 'robot',
    fields: [
      { path: 'settings.agentClient', label: 'Agent client', type: 'select', optionsFrom: 'agentClients', hint: 'The CLI the bridge drives. Switching resets the model when the current one belongs to another CLI.' },
      { path: 'settings.defaultMode', label: 'Default mode', type: 'select', options: ['agent', 'plan'] },
      { path: 'settings.planFirst', label: 'Plan before acting', type: 'boolean', hint: 'Ask the agent to submit a plan for approval before it edits anything.' },
      { path: 'settings.defaultActiveModel', label: 'Default model', type: 'text', hint: 'Model id for new sessions. "auto" passes no --model flag and is valid on every CLI.' },
      { path: 'settings.defaultActiveEffort', label: 'Default effort', type: 'text', hint: 'Leave empty to let the CLI decide.' },
      { path: 'settings.defaultActiveFast', label: 'Default to the fast tier', type: 'boolean' },
      { path: 'settings.preRunFlags', label: 'Extra CLI flags', type: 'list', hint: 'Passed on every spawn. Permission flags are owned by the permission mode — do not add them here.' },
    ],
  },
  {
    id: 'wake',
    title: 'Wake words & turns',
    blurb: 'What starts, ends and cancels a spoken turn',
    icon: 'mic',
    fields: [
      { path: 'settings.voice.wakeWordsEnabled', label: 'Wake words enabled', type: 'boolean', hint: 'Off means the phone uses on-screen Speak / Cancel instead of the Vosk spotters.' },
      { path: 'settings.voice.wakeWords.start', label: 'Start word', type: 'text' },
      { path: 'settings.voice.wakeWords.end', label: 'Submit word', type: 'text' },
      { path: 'settings.voice.wakeWords.cancel', label: 'Cancel word', type: 'text' },
      { path: 'settings.voice.wakeWords.wakeConfidenceThreshold', label: 'Wake confidence', type: 'number', min: 0, max: 1, hint: '0–1. Lower catches more, and misfires more.' },
      { path: 'settings.voice.turnSubmit.vadEnabled', label: 'Voice activity detection', type: 'boolean' },
      { path: 'settings.voice.turnSubmit.silenceMs', label: 'Silence before submit', type: 'number', min: 200, max: 10000, unit: 'ms' },
      { path: 'settings.voice.touchControls', label: 'On-screen controls', type: 'select', options: ['off', 'when_muted', 'always'] },
      { path: 'settings.voice.defaultMicMuted', label: 'Start sessions muted', type: 'boolean' },
      { path: 'settings.voice.workerPollTimeoutMs', label: 'Worker poll timeout', type: 'number', min: 5000, max: 60000, unit: 'ms' },
    ],
  },
  {
    id: 'speech',
    title: 'Speech output',
    blurb: 'When the agent speaks, and how it sounds',
    icon: 'unmute',
    fields: [
      { path: 'settings.voice.tts.agentVoiceEnabled', label: 'Speak agent replies', type: 'boolean' },
      { path: 'settings.voice.tts.errorSoundEnabled', label: 'Sound on error', type: 'boolean' },
      { path: 'settings.voice.tts.errorSpeakEnabled', label: 'Speak errors aloud', type: 'boolean' },
      { path: 'settings.voice.tts.webkit.rate', label: 'Rate', type: 'number', min: 0.5, max: 2 },
      { path: 'settings.voice.tts.webkit.pitch', label: 'Pitch', type: 'number', min: 0, max: 2 },
      { path: 'settings.voice.tts.webkit.volume', label: 'Volume', type: 'number', min: 0, max: 1 },
      { path: 'settings.voice.tts.webkit.lang', label: 'Language', type: 'text' },
    ],
  },
  {
    id: 'jobs',
    title: 'Jobs',
    blurb: 'Concurrency, timeouts and cleanup',
    icon: 'tools',
    fields: [
      { path: 'settings.maxConcurrentJobs', label: 'Max concurrent jobs', type: 'number', min: 1, max: 16 },
      { path: 'settings.jobTimeoutMs', label: 'Job timeout', type: 'number', min: 10000, unit: 'ms' },
      { path: 'settings.ghostKillEnabled', label: 'Kill orphaned processes', type: 'boolean' },
      { path: 'settings.modelCacheTtlMs', label: 'Model cache TTL', type: 'number', min: 0, unit: 'ms', hint: 'How long a CLI model list is reused before re-probing.' },
    ],
  },
  {
    id: 'narrator',
    title: 'Narrator',
    blurb: 'Progress commentary while a worker runs',
    icon: 'broadcast',
    fields: [
      { path: 'settings.narratorEnabled', label: 'Narrator enabled', type: 'boolean' },
      { path: 'settings.narratorCadenceMs', label: 'Cadence', type: 'number', min: 1000, unit: 'ms' },
      { path: 'settings.narratorMaxBufferEvents', label: 'Max buffered events', type: 'number', min: 1 },
    ],
  },
  {
    id: 'workflow',
    title: 'Workflow & LLM',
    blurb: 'Who is the brain: the CLI itself, or a model orchestrating it',
    icon: 'circuit-board',
    fields: [
      { path: 'settings.workflow.default', label: 'Workflow', type: 'select', options: ['agent_native', 'llm_intelligence'] },
      { path: 'settings.workflow.llmIntelligence.llm.model', label: 'Orchestrator model', type: 'text' },
      { path: 'settings.workflow.llmIntelligence.llm.region', label: 'Region', type: 'text' },
      { path: 'settings.workflow.llmIntelligence.llm.maxTokens', label: 'Max tokens', type: 'number', min: 256 },
      { path: 'settings.workflow.llmIntelligence.memory.maxTurns', label: 'Memory: max turns', type: 'number', min: 1 },
      { path: 'settings.workflow.llmIntelligence.memory.keepTurns', label: 'Memory: keep turns', type: 'number', min: 1 },
      { path: 'settings.workflow.llmIntelligence.readOutputMaxChars', label: 'Read output limit', type: 'number', min: 500, unit: 'chars' },
    ],
  },
  {
    id: 'ports',
    title: 'Run mode & ports',
    blurb: 'Where the bridge and the web app listen',
    icon: 'server',
    fields: [
      { path: 'settings.runMode', label: 'Run mode', type: 'select', options: ['test', 'serve'], hint: 'NODE_ENV=development always forces test.' },
      { path: 'settings.runModes.test.backendPort', label: 'Test: bridge port', type: 'number', min: 1024, max: 65535 },
      { path: 'settings.runModes.test.webPort', label: 'Test: web port', type: 'number', min: 1024, max: 65535, hint: 'Must match the port ng serve binds, or the bridge proxies to nothing.' },
      { path: 'settings.runModes.serve.backendPort', label: 'Serve: bridge port', type: 'number', min: 1024, max: 65535 },
      { path: 'settings.runModes.serve.publicBaseUrl', label: 'Serve: public URL', type: 'text' },
    ],
  },
  {
    id: 'personal',
    title: 'Personal & logging',
    blurb: 'How the agent addresses you, and how loud the bridge is',
    icon: 'account',
    fields: [
      { path: 'settings.userName', label: 'Your name', type: 'text', hint: 'Used by the voice agent when addressing you.' },
      { path: 'settings.logLevel', label: 'Log level', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error'] },
    ],
  },
];
