/**
 * Running the bridge from outside it — the `squeakr` CLI's control
 * commands (sessions, use, new, agent stop, say, config, default), served over
 * `/api/control/*` (routes.ts). Chat channels reach the same commands by
 * running the CLI (channels/commands.ts), so there is one implementation.
 */

/** The `squeakr` commands that drive the agent — what a chat may run besides read-only host checks. */
export const CONTROL_COMMANDS = ['agent', 'projects', 'project', 'sessions', 'use', 'new', 'say', 'config', 'default'] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export interface SessionRow {
  handle: string;
  name: string;
  kind: string;
  project: string;
  providerName: string;
  sessionId: string | null;
  status: string;
  lastActivityAt: string | null;
  summary: string | null;
}

export interface BridgeStatus {
  workflow: string;
  agentName: string;
  activeProject: string | null;
  agentRunning: boolean;
  agentSessionId: string | null;
  listener: string;
  stt: string | null;
  tts: string | null;
}

export interface ConfigKeyInfo {
  key: string;
  help: string;
  /** Allowed values, when it is a choice. */
  choices?: readonly string[];
}

/** The bridge, as the control commands see it (ops.ts in production, a fake in tests). */
export interface BridgeOps {
  status(): BridgeStatus;
  projects(): { name: string; active: boolean }[];
  /** Make a project active; returns its canonical name. Throws if unknown. */
  setProject(name: string): string;
  sessions(project?: string): SessionRow[];
  /** Continue this session on the next turn (the phone's session picker). Throws if it cannot. */
  selectSession(project: string, sessionId: string): string;
  newSession(project?: string): Promise<string>;
  stopAgent(): boolean;
  configKeys(): ConfigKeyInfo[];
  getConfig(key: string): string;
  setConfig(key: string, value: string): Promise<string>;
}
