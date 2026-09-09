/**
 * agent_permission_mode — read or change the active CLI's approval policy.
 * Backed by providers/agents/permissions.ts; the REST route in
 * routes/providerPermissions.ts uses the same functions.
 */

import { describePermissionModes, setPermissionMode, type PermissionModesView } from '../../providers/agents/permissions.js';

export interface PermissionModeArgs {
  /** Omit to read; pass a mode id from `modes` to change it. */
  mode?: string;
}

export function handlePermissionMode(args: PermissionModeArgs): PermissionModesView & { changed: boolean } {
  if (args.mode && args.mode.trim()) {
    return { ...setPermissionMode(args.mode), changed: true };
  }
  return { ...describePermissionModes(), changed: false };
}
