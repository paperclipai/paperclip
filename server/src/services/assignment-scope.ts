import { tasksAssignScopeSchema } from "@paperclipai/shared";

export type AssignmentScopeRule = {
  projectIds: Set<string>;
  allowAllProjects: boolean;
  allowedAssigneeAgentIds: Set<string>;
  allowedAssigneeRoles: Set<string>;
  deniedAssigneeRoles: Set<string>;
  allowUnassign: boolean;
  allowAssignToUsers: boolean;
};

export type AssignmentScopeDenyReason =
  | "invalid_scope"
  | "project_out_of_scope"
  | "assignee_agent_out_of_scope"
  | "assignee_role_out_of_scope"
  | "assignee_role_denied"
  | "assign_user_not_allowed"
  | "unassign_not_allowed";

type AssignmentScopeDecision =
  | { allowed: true }
  | { allowed: false; reason: AssignmentScopeDenyReason };

type ParseAssignmentScopeResult =
  | { ok: true; scope: AssignmentScopeRule }
  | { ok: false; reason: "invalid_scope"; message: string };

type AssignmentIntent = {
  projectId: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  assigneeAgentRole: string | null | undefined;
  assigneeUserId: string | null | undefined;
};

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRole(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseTasksAssignScope(scope: Record<string, unknown> | null | undefined): ParseAssignmentScopeResult {
  const parsed = tasksAssignScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_scope",
      message: parsed.error.issues[0]?.message ?? "Invalid tasks:assign_scope grant",
    };
  }

  const value = parsed.data;
  const normalizedProjectIds = new Set(value.projectIds.map((projectId) => projectId.trim().toLowerCase()));
  const normalizedAssigneeAgentIds = new Set(
    (value.allowedAssigneeAgentIds ?? []).map((agentId) => agentId.trim().toLowerCase()),
  );
  const normalizedAllowedRoles = new Set(
    (value.allowedAssigneeRoles ?? []).map((role) => role.trim().toLowerCase()),
  );
  const normalizedDeniedRoles = new Set(
    (value.deniedAssigneeRoles ?? ["ceo"]).map((role) => role.trim().toLowerCase()),
  );

  return {
    ok: true,
    scope: {
      projectIds: normalizedProjectIds,
      allowAllProjects: normalizedProjectIds.has("*"),
      allowedAssigneeAgentIds: normalizedAssigneeAgentIds,
      allowedAssigneeRoles: normalizedAllowedRoles,
      deniedAssigneeRoles: normalizedDeniedRoles,
      allowUnassign: value.allowUnassign ?? false,
      allowAssignToUsers: value.allowAssignToUsers ?? false,
    },
  };
}

export function evaluateTasksAssignScope(scope: AssignmentScopeRule, intent: AssignmentIntent): AssignmentScopeDecision {
  const projectId = normalizeId(intent.projectId);
  if (!projectId) return { allowed: false, reason: "project_out_of_scope" };
  if (!scope.allowAllProjects && !scope.projectIds.has(projectId)) {
    return { allowed: false, reason: "project_out_of_scope" };
  }

  const assigneeAgentId = normalizeId(intent.assigneeAgentId);
  const assigneeUserId = normalizeId(intent.assigneeUserId);
  if (!assigneeAgentId && !assigneeUserId) {
    if (scope.allowUnassign) return { allowed: true };
    return { allowed: false, reason: "unassign_not_allowed" };
  }

  if (assigneeUserId) {
    if (scope.allowAssignToUsers) return { allowed: true };
    return { allowed: false, reason: "assign_user_not_allowed" };
  }

  if (!assigneeAgentId) {
    return { allowed: false, reason: "assignee_agent_out_of_scope" };
  }

  const assigneeRole = normalizeRole(intent.assigneeAgentRole);
  if (assigneeRole && scope.deniedAssigneeRoles.has(assigneeRole)) {
    return { allowed: false, reason: "assignee_role_denied" };
  }

  const allowedByAgentId = scope.allowedAssigneeAgentIds.has(assigneeAgentId);
  const allowedByRole = assigneeRole ? scope.allowedAssigneeRoles.has(assigneeRole) : false;
  if (allowedByAgentId || allowedByRole) return { allowed: true };

  if (scope.allowedAssigneeRoles.size > 0) {
    return { allowed: false, reason: "assignee_role_out_of_scope" };
  }
  return { allowed: false, reason: "assignee_agent_out_of_scope" };
}

export function assignmentScopeStrictModeEnabled() {
  return process.env.PAPERCLIP_ASSIGN_SCOPE_STRICT === "true";
}
