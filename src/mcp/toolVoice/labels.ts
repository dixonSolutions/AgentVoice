import { truncate } from './truncate.js';

export function toolStartLabel(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'cursor_set_project':
      return `Setting project → ${String(a['project'] ?? 'active')}`;
    case 'cursor_list_projects':
      return 'Listing projects';
    case 'cursor_manage_projects': {
      const action = String(a['action'] ?? 'list');
      return `Managing projects → ${action}`;
    }
    case 'cursor_ask':
      return `Asking Cursor (CLI) → ${truncate(String(a['question'] ?? 'question'), 72)}`;
    case 'cursor_submit':
      return `Sending task to Cursor → ${truncate(String(a['prompt'] ?? 'task'), 72)}`;
    case 'cursor_status':
      return 'Checking Cursor progress';
    case 'cursor_stop':
      return 'Stopping Cursor job';
    case 'cursor_recall_answer':
      return 'Recalling last Cursor answer';
    case 'cursor_set_model':
      return `Setting model → ${String(a['model_id'] ?? '')}`;
    case 'cursor_new_session':
      return 'Starting fresh Cursor thread';
    case 'cursor_session_info':
      return 'Reading Cursor session info';
    case 'cursor_diff':
      return 'Reading git diff';
    case 'cursor_revert':
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
    case 'cursor_set_project':
      return `Project set → ${String(r['active_project'] ?? 'ok')}`;
    case 'cursor_manage_projects':
      return `Projects ${String(r['action'] ?? 'updated')}`;
    case 'cursor_ask':
      return 'Cursor answered';
    case 'cursor_submit':
      return `Job started → ${String(r['job_id'] ?? 'running')}`;
    case 'cursor_status': {
      const activity = typeof r['activity'] === 'string' ? r['activity'] : null;
      return activity ? `Progress → ${truncate(activity, 80)}` : 'Status checked';
    }
    case 'cursor_recall_answer':
      return 'Answer recalled';
    default:
      return `${tool.replace(/_/g, ' ')} — done`;
  }
}
