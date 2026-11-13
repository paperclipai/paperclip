import type { PermissionKey } from "@paperclipai/shared";

/** Domain actions use the ordinary grant evaluator, including its user ceiling. */
export const CONNECTION_MANAGEMENT_PERMISSIONS = {
  "connections:read": "tools:manage_connections",
  "connections:configure": "tools:manage_connections",
  "connections:profiles": "tools:manage_profiles",
  "connections:gateway": "tools:manage_connections",
  "connections:audit": "tools:view_audit",
  "connections:runtime": "tools:manage_runtime",
  "connections:test": "tools:use",
} as const satisfies Record<string, PermissionKey>;

export type ConnectionManagementAction = keyof typeof CONNECTION_MANAGEMENT_PERMISSIONS;

export function isConnectionManagementAction(action: string): action is ConnectionManagementAction {
  return Object.hasOwn(CONNECTION_MANAGEMENT_PERMISSIONS, action);
}

/** Values come from resolved database rows, never caller-selected identities. */
export interface ConnectionManagementResource {
  type: "connection_management";
  companyId: string;
  connectionId?: string | null;
  profileId?: string | null;
  gatewayId?: string | null;
  provider?: string | null;
  requestedProvider?: string | null;
  purpose?: "tool" | "chat" | "ai";
  operation: string;
  readOnly?: boolean;
  targetAgentId?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  routineId?: string | null;
  /** Personal self-service/creator authority, only for operations that permit it. */
  selfServiceUserId?: string | null;
  /** Resolved installation diff changes only agent targets, preserving company sharing. */
  selfServiceAgentInstalls?: boolean;
  requestedInstallCompanyIds?: string[];
}
