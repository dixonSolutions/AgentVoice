import { truncate } from './truncate.js';

export function toolStartLabel(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'agent_set_project':
      return `Setting project → ${String(a['project'] ?? 'active')}`;
    case 'agent_list_projects':
      return 'Listing projects';
    case 'agent_manage_projects': {
      const action = String(a['action'] ?? 'list');
      return `Managing projects → ${action}`;
    }
    case 'agent_ask':
      return `Asking Cursor (CLI) → ${truncate(String(a['question'] ?? 'question'), 72)}`;
    case 'agent_submit':
      return `Sending task to Cursor → ${truncate(String(a['prompt'] ?? 'task'), 72)}`;
    case 'agent_job_status':
      return 'Checking Cursor progress';
    case 'agent_job_stop':
      return 'Stopping Cursor job';
    case 'agent_recall_answer':
      return 'Recalling last Cursor answer';
    case 'agent_set_model':
      return a['scope'] === 'session'
        ? `Setting model (this session only) → ${String(a['model_id'] ?? '')}`
        : `Setting model (default + all sessions) → ${String(a['model_id'] ?? '')}`;
    case 'agent_new_session':
      return 'Starting fresh Cursor thread';
    case 'agent_session_info':
      return 'Reading Cursor session info';
    case 'agent_diff':
      return 'Reading git diff';
    case 'agent_revert':
      return 'Reverting changes';
    default:
      return tool.replace(/_/g, ' ');
  }
}

export function toolDoneLabel(tool: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (typeof r['error'] === 'string') {
    return `${toolStartLabel(tool, {})} — failed`;
  }
  switch (tool) {
    case 'agent_set_project':
      return `Project set → ${String(r['active_project'] ?? 'ok')}`;
    case 'agent_manage_projects':
      return `Projects ${String(r['action'] ?? 'updated')}`;
    case 'agent_ask':
      return 'Cursor answered';
    case 'agent_submit':
      return `Job started → ${String(r['job_id'] ?? 'running')}`;
    case 'agent_job_status': {
      const activity = typeof r['activity'] === 'string' ? r['activity'] : null;
      return activity ? `Progress → ${truncate(activity, 80)}` : 'Status checked';
    }
    case 'agent_recall_answer':
      return 'Answer recalled';
    default:
      return `${tool.replace(/_/g, ' ')} — done`;
  }
}
