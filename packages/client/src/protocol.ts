/**
 * Wire types shared by every AgentVoice frontend (PWA, VS Code / Cursor
 * extension). The bridge (src/) is the source of truth for behaviour; this
 * file mirrors the shapes it sends so two clients can never drift apart on
 * what an approval card or an agent event looks like.
 *
 * Keep this file dependency-free and framework-free.
 */

// ── Approvals (mcp/server/approvalRegistry.ts) ─────────────────────────────

export type InputType = 'yesno' | 'choice' | 'freetext';

export interface UserInputRequest {
  kind: 'user_input';
  request_id: string;
  question: string;
  input_type: InputType;
  options?: string[];
}

export interface PlanApprovalRequest {
  kind: 'plan_approval';
  request_id: string;
  title: string;
  steps: string[];
  estimated_impact?: string;
}

/** A CLI permission prompt relayed from the agent (Claude Code --permission-prompt-tool). */
export interface PermissionRequest {
  kind: 'permission';
  request_id: string;
  provider: string;
  tool_name: string;
  summary: string;
  input: unknown;
}

/** A password prompt from sudo / git / ssh inside the agent's shell. */
export interface SecretInputRequest {
  kind: 'secret_input';
  request_id: string;
  prompt: string;
  source: 'sudo' | 'git' | 'ssh' | 'other';
  agent?: string;
}

export type ApprovalRequest =
  | UserInputRequest
  | PlanApprovalRequest
  | PermissionRequest
  | SecretInputRequest;

export interface UserInputResponse {
  kind: 'user_input';
  answer: string;
}

export interface PlanApprovalResponse {
  kind: 'plan_approval';
  decision: 'approved' | 'rejected' | 'modified';
  notes?: string;
}

export interface PermissionResponse {
  kind: 'permission';
  decision: 'allow' | 'deny';
  message?: string;
}

export interface SecretInputResponse {
  kind: 'secret_input';
  /** null = cancelled; the prompt fails on the host. */
  secret: string | null;
}

export type ApprovalResponse =
  | UserInputResponse
  | PlanApprovalResponse
  | PermissionResponse
  | SecretInputResponse;

/** Map a push frame `{ type: "*_request", ... }` to an ApprovalRequest, or null. */
export function approvalFromPush(msg: Record<string, unknown>): ApprovalRequest | null {
  const id = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
  if (!id) return null;
  switch (msg['type']) {
    case 'user_input_request':
      return {
        kind: 'user_input',
        request_id: id,
        question: String(msg['question'] ?? ''),
        input_type: (msg['input_type'] as InputType) ?? 'freetext',
        options: Array.isArray(msg['options']) ? (msg['options'] as string[]) : undefined,
      };
    case 'plan_approval_request':
      return {
        kind: 'plan_approval',
        request_id: id,
        title: String(msg['title'] ?? 'Plan'),
        steps: Array.isArray(msg['steps']) ? (msg['steps'] as string[]) : [],
        estimated_impact:
          typeof msg['estimated_impact'] === 'string' ? msg['estimated_impact'] : undefined,
      };
    case 'permission_request':
      return {
        kind: 'permission',
        request_id: id,
        provider: typeof msg['provider'] === 'string' ? msg['provider'] : 'Agent',
        tool_name: typeof msg['tool_name'] === 'string' ? msg['tool_name'] : 'tool',
        summary: typeof msg['summary'] === 'string' ? msg['summary'] : '',
        input: msg['input'],
      };
    case 'secret_input_request':
      return {
        kind: 'secret_input',
        request_id: id,
        prompt: typeof msg['prompt'] === 'string' ? msg['prompt'] : 'Password:',
        source: (msg['source'] as SecretInputRequest['source']) ?? 'other',
        agent: typeof msg['agent'] === 'string' ? msg['agent'] : undefined,
      };
    default:
      return null;
  }
}

// ── Agent stream events (providers/agents/events.ts) ───────────────────────

export type ToolAction = 'write' | 'read' | 'search' | 'shell' | 'task' | 'other';

export interface NormalizedToolCall {
  name: string;
  action: ToolAction;
  path?: string;
  command?: string;
  subagent?: string;
}

export type AgentStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'init'; model?: string }
  | { kind: 'tool_start'; tool: NormalizedToolCall }
  | { kind: 'tool_done'; tool: NormalizedToolCall; success?: boolean }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'result'; text: string | null }
  | { kind: 'error'; message: string };

/** `/ws/events` frame wrapping one normalized CLI event. */
export interface AgentEventFrame {
  type: 'agent_event';
  source: 'voice' | 'worker';
  pid: number;
  project: string;
  run_id?: string;
  mode?: string;
  worktree?: string | null;
  event: AgentStreamEvent;
  ts?: string;
}

// ── Desk snapshot (routes/eventsSocket.ts deskStateSnapshot) ──────────────

export interface PermissionModeDescriptor {
  id: string;
  label: string;
  description: string;
  prompts: 'phone' | 'deny' | 'never';
  yolo?: boolean;
}

export interface VoiceAgentSummary {
  run_id: string;
  pid: number;
  session_id: string | null;
  project: string;
  state: string;
}

export interface ActiveJobSummary {
  jobId: string;
  project: string;
  mode: string;
  prompt: string;
  pid: number;
  elapsedMs: number;
  activity: string | null;
  worktree?: string;
}

export interface DeskState {
  provider: { id: string; displayName: string };
  workflow: 'agent_native' | 'llm_intelligence';
  activeProject: string | null;
  activeModel: string;
  activeEffort: string | null;
  activeFast: boolean;
  permissionMode: PermissionModeDescriptor;
  pending: ApprovalRequest[];
  voice_agent: VoiceAgentSummary | null;
  listening: boolean;
  pending_user_turns: number;
  jobs: ActiveJobSummary[];
}

// ── Voice-session frames (mcp/server/voiceToolHandlers.ts) ─────────────────

export interface ToolActivityFrame {
  type: 'tool_activity';
  tool: string;
  phase: 'start' | 'done' | 'error';
  label?: string;
  detail?: string;
}

export interface VoiceAgentStatusFrame {
  type: 'voice_agent_status';
  run_id: string;
  pid: number;
  session_id: string | null;
  mcp_session_id: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
  provider: string;
  provider_name: string;
}

export interface UserTurnFrame {
  type: 'user_turn';
  text: string;
  source: string;
  delivery: string;
  run_id: string | null;
}

/** Every frame a desk client can receive. Unknown types are passed through as `RawFrame`. */
export type DeskFrame =
  | ({ type: 'auth_ok'; sessionKey: string; client: 'events' } & DeskState)
  | ({ type: 'pong' } & DeskState)
  | { type: 'speak'; text: string }
  | { type: 'assistant_transcript'; text: string }
  | { type: 'thinking'; value: boolean }
  | { type: 'turn_complete' }
  | { type: 'turn_accepted'; delivery: string; project: string; run_id: string | null; pid: number | null }
  | { type: 'narration'; text: string; kind?: string }
  | { type: 'approval_cancelled'; request_id: string | null; reason?: string; by?: string }
  | { type: 'approval_ack'; request_id: string | null; ok: boolean; reason?: string }
  | { type: 'error'; message: string; code?: string }
  | ToolActivityFrame
  | VoiceAgentStatusFrame
  | UserTurnFrame
  | AgentEventFrame
  | RawFrame;

export interface RawFrame {
  type: string;
  [key: string]: unknown;
}

// ── REST shapes ───────────────────────────────────────────────────────────

export interface ProjectSummary {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  description?: string;
  vendor?: string;
  efforts?: string[];
  defaultEffort?: string | null;
  fast?: boolean;
  variants?: Array<{ effort: string | null; fast: boolean; id: string }>;
}

export interface ModelsView {
  models: ModelEntry[];
  active_model: string;
  active_effort?: string | null;
  active_fast?: boolean;
  [key: string]: unknown;
}

export interface PermissionModesView {
  provider: string;
  displayName: string;
  active: PermissionModeDescriptor;
  modes: PermissionModeDescriptor[];
}

export interface SessionEntry {
  session_id: string;
  last_prompt: string;
  last_status: string;
  last_run_at: string;
  job_count: number;
}

export interface SessionsResponse {
  project: string;
  active_session_id: string | null;
  sessions: SessionEntry[];
}

export interface WorkspaceProjectView {
  name: string;
  path: string;
  description: string | null;
  ephemeral: boolean;
}

export interface TurnAccepted {
  ok: true;
  delivery: string;
  project: string;
  run_id: string | null;
  pid: number | null;
  session_id: string | null;
}

export interface JobHistoryEntry {
  id: string;
  project: string;
  mode: string;
  prompt: string;
  status: string;
  session_id: string | null;
  summary: string | null;
  error: string | null;
  files_changed: number | null;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  checkpoint: string | null;
}

export interface DiffResult {
  project: string;
  diffstat: string;
  patch: string | null;
  clean: boolean;
}

export interface HealthInfo {
  status: string;
  agentClient: string;
  cliVersion: string | null;
  appVersion: string;
  gitCommit: string | null;
  runMode: string;
  backendUrl: string;
  [key: string]: unknown;
}
