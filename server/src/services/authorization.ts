import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";

export type AuthorizationActor =
  {
    type: "board" | "agent" | "none";
    userId?: string | null;
    companyIds?: string[];
    memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
    isInstanceAdmin?: boolean;
    agentId?: string | null;
    companyId?: string | null;
    source?:
      | "local_implicit"
      | "session"
      | "board_key"
      | "agent_key"
      | "agent_jwt"
      | "cloud_tenant"
      | "none";
  };

export type AuthorizationAction =
  | PermissionKey
  | "agent_config:read"
  | "agent_config:update"
  | "issue:mutate";

export type AuthorizationResource =
  | { type: "company"; companyId: string }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | {
      type: "issue";
      companyId: string;
      issueId?: string | null;
      projectId?: string | null;
      parentIssueId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      status?: string | null;
    };

export type AuthorizationDecision = {
  allowed: boolean;
  action: AuthorizationAction;
  explanation: string;
  reason:
    | "allow_local_board"
    | "allow_instance_admin"
    | "allow_explicit_grant"
    | "allow_legacy_agent_creator"
    | "allow_self"
    | "allow_company_agent"
    | "allow_simple_company_member"
    | "allow_manager_chain"
    | "deny_unauthenticated"
    | "deny_company_boundary"
    | "deny_missing_membership"
    | "deny_missing_grant"
    | "deny_policy_restricted"
    | "deny_scope"
    | "deny_unsupported_action";
  grant?: {
    principalType: PrincipalType;
    principalId: string;
    permissionKey: PermissionKey;
    scope: Record<string, unknown> | null;
  };
};

type PrincipalGrantDecision = AuthorizationDecision & {
  grant?: NonNullable<AuthorizationDecision["grant"]>;
};

function companyIdForResource(resource: AuthorizationResource) {
  return resource.companyId;
}

function permissionForAction(action: AuthorizationAction): PermissionKey | null {
  if (action === "agent_config:read" || action === "agent_config:update") return "agents:create";
  if (action === "issue:mutate") return null;
  return action;
}

function canCreateAgentsLegacy(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
  if (agent.role === "ceo") return true;
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean(agent.permissions.canCreateAgents);
}

function scopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function prefixedScopeValues(grantScope: Record<string, unknown>, prefix: string) {
  return scopeValueList(grantScope.allow)
    .filter((rule) => rule.startsWith(prefix))
    .map((rule) => rule.slice(prefix.length))
    .filter((value) => value.length > 0);
}

function scopeValuesForKeys(grantScope: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => scopeValueList(grantScope[key]));
}

function scopeIncludesId(ids: string[], id: string | null | undefined) {
  return Boolean(id && ids.includes(id));
}

function isSimpleAssignableAgentStatus(status: string | null | undefined) {
  return status !== "pending_approval" && status !== "terminated";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectIsEmpty(value: Record<string, unknown>) {
  return Object.keys(value).length === 0;
}

function readPolicyObject(container: unknown, key: string): Record<string, unknown> | null {
  if (!isPlainRecord(container)) return null;
  const value = container[key];
  return isPlainRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type AssignmentPolicyEffect =
  | { kind: "none" }
  | { kind: "restricted"; explanation: string }
  | { kind: "requires_approval"; explanation: string }
  | { kind: "unknown"; explanation: string };

type AgentHierarchyRow = { id: string; reportsTo: string | null };

function evaluateAuthorizationPolicyForAssignment(
  policy: Record<string, unknown> | null | undefined,
  label: string,
): AssignmentPolicyEffect {
  if (!policy || objectIsEmpty(policy)) return { kind: "none" };

  const agentVisibility = readPolicyObject(policy, "agentVisibility");
  const assignmentPolicy = readPolicyObject(policy, "assignmentPolicy");
  const protectedAgent = readPolicyObject(policy, "protectedAgent");
  const knownTopLevelKeys = new Set([
    "agentVisibility",
    "assignmentPolicy",
    "protectedAgent",
    "managedBy",
  ]);
  const hasUnknownTopLevelKey = Object.keys(policy).some((key) => !knownTopLevelKeys.has(key));
  const hasKnownPolicySection = Boolean(agentVisibility || assignmentPolicy || protectedAgent);
  if (hasUnknownTopLevelKey || !hasKnownPolicySection) {
    return {
      kind: "unknown",
      explanation: `${label} has authorization policy data that core cannot evaluate for task assignment.`,
    };
  }

  const visibilityMode = readString(agentVisibility?.mode);
  if (visibilityMode && visibilityMode !== "discoverable" && visibilityMode !== "private") {
    return {
      kind: "unknown",
      explanation: `${label} has an unsupported agent visibility policy mode.`,
    };
  }

  const assignmentMode = readString(assignmentPolicy?.mode);
  if (assignmentMode && assignmentMode !== "company_default" && assignmentMode !== "protected") {
    return {
      kind: "unknown",
      explanation: `${label} has an unsupported assignment policy mode.`,
    };
  }

  const requiresApproval =
    readBoolean(protectedAgent?.requiresApproval) === true ||
    readBoolean(assignmentPolicy?.protectedAgentRequiresApproval) === true;
  if (requiresApproval) {
    return {
      kind: "requires_approval",
      explanation: `${label} requires approval before task assignment.`,
    };
  }

  if (
    visibilityMode === "private" ||
    readBoolean(agentVisibility?.hiddenFromDefaultDirectory) === true
  ) {
    return {
      kind: "restricted",
      explanation: `${label} is private and cannot use simple company-wide task assignment.`,
    };
  }

  if (assignmentMode === "protected") {
    return {
      kind: "restricted",
      explanation: `${label} is protected and requires an explicit assignment grant.`,
    };
  }

  return { kind: "none" };
}

function agentIsInSubtree(
  agentsById: Map<string, AgentHierarchyRow>,
  rootAgentId: string,
  targetAgentId: string,
) {
  if (rootAgentId === targetAgentId) return true;

  let cursor: string | null = targetAgentId;
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    const current = agentsById.get(cursor);
    if (!current) return false;
    if (current.reportsTo === rootAgentId) return true;
    cursor = current.reportsTo;
  }
  return false;
}

async function loadCompanyAgentHierarchy(db: Db, companyId: string) {
  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return new Map(rows.map((agent) => [agent.id, agent]));
}

async function isAgentInSubtree(db: Db, companyId: string, rootAgentId: string, targetAgentId: string) {
  return agentIsInSubtree(
    await loadCompanyAgentHierarchy(db, companyId),
    rootAgentId,
    targetAgentId,
  );
}

async function scopeAllows(
  db: Db,
  companyId: string,
  grantScope: Record<string, unknown> | null,
  requestedScope: Record<string, unknown> | null | undefined,
  options: { requireStructuredScope?: boolean } = {},
) {
  if (!grantScope || Object.keys(grantScope).length === 0) return !options.requireStructuredScope;
  if (!requestedScope) return false;

  const targetAssigneeAgentId =
    typeof requestedScope.assigneeAgentId === "string"
      ? requestedScope.assigneeAgentId
      : typeof requestedScope.targetAgentId === "string"
        ? requestedScope.targetAgentId
        : null;
  const requestedProjectId = typeof requestedScope.projectId === "string" ? requestedScope.projectId : null;
  let constrained = false;

  const projectIds = [
    ...scopeValueList(grantScope.projectId),
    ...scopeValueList(grantScope.projectIds),
    ...prefixedScopeValues(grantScope, "project:"),
  ];
  if (projectIds.length > 0) {
    constrained = true;
    if (!scopeIncludesId(projectIds, requestedProjectId)) return false;
  }

  const targetAgentIds = [
    ...scopeValuesForKeys(grantScope, [
      "agentId",
      "agentIds",
      "assigneeAgentId",
      "assigneeAgentIds",
      "targetAgentId",
      "targetAgentIds",
    ]),
    ...prefixedScopeValues(grantScope, "agent:"),
  ];
  if (targetAgentIds.length > 0) {
    constrained = true;
    if (!scopeIncludesId(targetAgentIds, targetAssigneeAgentId)) return false;
  }

  const subtreeRootAgentIds = [
    ...scopeValuesForKeys(grantScope, [
      "managerAgentId",
      "managerAgentIds",
      "managedSubtreeAgentId",
      "managedSubtreeAgentIds",
      "subtreeAgentId",
      "subtreeAgentIds",
      "subtreeRootAgentId",
      "subtreeRootAgentIds",
    ]),
    ...prefixedScopeValues(grantScope, "subtree:"),
  ];
  if (subtreeRootAgentIds.length > 0) {
    constrained = true;
    if (!targetAssigneeAgentId) return false;
    const agentsById = await loadCompanyAgentHierarchy(db, companyId);
    let matchesSubtree = false;
    for (const rootAgentId of subtreeRootAgentIds) {
      if (agentIsInSubtree(agentsById, rootAgentId, targetAssigneeAgentId)) {
        matchesSubtree = true;
        break;
      }
    }
    if (!matchesSubtree) return false;
  }

  // Unknown metadata keys do not constrain the grant. Recognized constraints
  // return false above when they fail to match the requested assignment scope.
  return !constrained ? true : constrained;
}

function allow(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: true };
}

function deny(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: false };
}

export function authorizationService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    if (
      await db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null)
    ) {
      return true;
    }
    return false;
  }

  async function getActiveMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function findGrant(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function decidePrincipalGrant(input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    action: AuthorizationAction;
    permissionKey: PermissionKey;
    scope?: Record<string, unknown> | null;
  }): Promise<PrincipalGrantDecision> {
    const membership = await getActiveMembership(input.companyId, input.principalType, input.principalId);
    if (!membership) {
      return deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation: `${input.principalType} principal ${input.principalId} is not an active member of company ${input.companyId}.`,
      });
    }

    const grant = await findGrant(input.companyId, input.principalType, input.principalId, input.permissionKey);
    if (!grant) {
      return deny({
        action: input.action,
        reason: "deny_missing_grant",
        explanation: `Missing permission: ${input.permissionKey}.`,
      });
    }

    if (
      !(await scopeAllows(db, input.companyId, grant.scope, input.scope, {
        requireStructuredScope:
          input.permissionKey === "tasks:assign_scope" ||
          input.permissionKey === "tasks:fallback_reassign",
      }))
    ) {
      return deny({
        action: input.action,
        reason: "deny_scope",
        explanation: `Permission ${input.permissionKey} does not cover the requested scope.`,
        grant: {
          principalType: input.principalType,
          principalId: input.principalId,
          permissionKey: input.permissionKey,
          scope: grant.scope ?? null,
        },
      });
    }

    return allow({
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: `Allowed by explicit grant ${input.permissionKey}.`,
      grant: {
        principalType: input.principalType,
        principalId: input.principalId,
        permissionKey: input.permissionKey,
        scope: grant.scope ?? null,
      },
    });
  }

  async function loadAgent(agentId: string) {
    return db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadProjectAuthorizationPolicy(companyId: string, projectId: string) {
    const row = await db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return readPolicyObject(row?.executionWorkspacePolicy, "authorizationPolicy");
  }

  async function loadIssueAuthorizationPolicy(companyId: string, issueId: string) {
    const row = await db
      .select({ executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return readPolicyObject(row?.executionPolicy, "authorizationPolicy");
  }

  async function assignmentTargetIsInCompany(resource: AuthorizationResource) {
    if (resource.type !== "issue") return true;
    if (resource.assigneeAgentId) {
      const target = await loadAgent(resource.assigneeAgentId);
      return Boolean(
        target &&
        target.companyId === resource.companyId &&
        isSimpleAssignableAgentStatus(target.status),
      );
    }
    if (resource.assigneeUserId) {
      return Boolean(await getActiveMembership(resource.companyId, "user", resource.assigneeUserId));
    }
    return true;
  }

  async function assignmentPolicyEffect(resource: AuthorizationResource): Promise<AssignmentPolicyEffect> {
    if (resource.type !== "issue") return { kind: "none" };

    const checks: Array<Promise<AssignmentPolicyEffect>> = [];
    if (resource.assigneeAgentId) {
      checks.push(
        loadAgent(resource.assigneeAgentId).then((agent) =>
          evaluateAuthorizationPolicyForAssignment(
            readPolicyObject(agent?.permissions, "authorizationPolicy"),
            "Target agent",
          ),
        ),
      );
    }
    if (resource.projectId) {
      checks.push(
        loadProjectAuthorizationPolicy(resource.companyId, resource.projectId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Target project"),
        ),
      );
    }
    if (resource.issueId) {
      checks.push(
        loadIssueAuthorizationPolicy(resource.companyId, resource.issueId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Target issue"),
        ),
      );
    }
    if (resource.parentIssueId && resource.parentIssueId !== resource.issueId) {
      checks.push(
        loadIssueAuthorizationPolicy(resource.companyId, resource.parentIssueId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Parent issue"),
        ),
      );
    }
    if (checks.length === 0) return { kind: "none" };

    const effects = await Promise.all(checks);
    return (
      effects.find((effect) => effect.kind === "unknown") ??
      effects.find((effect) => effect.kind === "requires_approval") ??
      effects.find((effect) => effect.kind === "restricted") ??
      { kind: "none" }
    );
  }

  async function isManagerOf(companyId: string, managerAgentId: string, assigneeAgentId: string) {
    return isAgentInSubtree(db, companyId, managerAgentId, assigneeAgentId);
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }): Promise<AuthorizationDecision> {
    const permissionKey = permissionForAction(input.action);
    const companyId = companyIdForResource(input.resource);

    async function decideWithTaskAssignmentGrants(
      principalType: PrincipalType,
      principalId: string,
    ): Promise<AuthorizationDecision> {
      const broadDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "tasks:assign",
        scope: input.scope,
      });
      if (broadDecision.allowed || broadDecision.reason === "deny_missing_membership") return broadDecision;
      const scopedDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "tasks:assign_scope",
        scope: input.scope,
      });
      if (scopedDecision.allowed || broadDecision.reason === "deny_missing_grant") return scopedDecision;
      return broadDecision;
    }

    async function denyForAssignmentPolicyIfNeeded(
      policyEffect: AssignmentPolicyEffect,
    ): Promise<AuthorizationDecision | null> {
      if (policyEffect.kind === "none" || policyEffect.kind === "restricted") return null;
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation: policyEffect.explanation,
      });
    }

    function denyRestrictedAssignmentPolicy(policyEffect: AssignmentPolicyEffect): AuthorizationDecision {
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation:
          policyEffect.kind === "restricted"
            ? policyEffect.explanation
            : "Restrictive authorization policy blocks simple company-wide task assignment.",
      });
    }

    if (input.actor.type === "none") {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Authentication required.",
      });
    }

    if (input.actor.type === "board") {
      let taskAssignmentPolicyEffect: AssignmentPolicyEffect | null = null;
      if (input.actor.source === "local_implicit") {
        return allow({
          action: input.action,
          reason: "allow_local_board",
          explanation: "Allowed because the actor is the local implicit board.",
        });
      }
      if (input.actor.isInstanceAdmin || await isInstanceAdmin(input.actor.userId)) {
        return allow({
          action: input.action,
          reason: "allow_instance_admin",
          explanation: "Allowed because the actor is an instance admin.",
        });
      }
      if (!input.actor.userId) {
        return deny({
          action: input.action,
          reason: "deny_unauthenticated",
          explanation: "Board user id is required.",
        });
      }
      if (input.action === "tasks:assign") {
        if (!(await assignmentTargetIsInCompany(input.resource))) {
          return deny({
            action: input.action,
            reason: "deny_company_boundary",
            explanation: "Task assignment target agent is not active in the target company.",
          });
        }
        const policyEffect = await assignmentPolicyEffect(input.resource);
        taskAssignmentPolicyEffect = policyEffect;
        const policyDeny = await denyForAssignmentPolicyIfNeeded(policyEffect);
        if (policyDeny) return policyDeny;
        const membership = await getActiveMembership(companyId, "user", input.actor.userId);
        if (policyEffect.kind === "none" && membership && membership.membershipRole !== "viewer") {
          return allow({
            action: input.action,
            reason: "allow_simple_company_member",
            explanation: "Allowed by simple mode company-wide task assignment default.",
          });
        }
      }
      if (!permissionKey) {
        return deny({
          action: input.action,
          reason: "deny_unsupported_action",
          explanation: `No board permission mapping exists for ${input.action}.`,
        });
      }
      if (input.action === "tasks:assign") {
        const grantDecision = await decideWithTaskAssignmentGrants("user", input.actor.userId);
        if (grantDecision.allowed) return grantDecision;
        const policyEffect = taskAssignmentPolicyEffect ?? await assignmentPolicyEffect(input.resource);
        if (policyEffect.kind === "restricted") return denyRestrictedAssignmentPolicy(policyEffect);
        return grantDecision;
      }
      return decidePrincipalGrant({
        companyId,
        principalType: "user",
        principalId: input.actor.userId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
    }

    const actorAgentId = input.actor.agentId ?? null;
    if (!actorAgentId) {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Agent authentication required.",
      });
    }
    if (input.actor.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Agent key cannot access another company.",
      });
    }

    const actorAgent = await loadAgent(actorAgentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Actor agent was not found in the target company.",
      });
    }

    if (input.action === "tasks:assign") {
      if (!isSimpleAssignableAgentStatus(actorAgent.status)) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: "Actor agent is not active for simple mode task assignment.",
        });
      }
      if (!(await assignmentTargetIsInCompany(input.resource))) {
        return deny({
          action: input.action,
          reason: "deny_company_boundary",
          explanation: "Task assignment target agent is not active in the target company.",
        });
      }
      const policyEffect = await assignmentPolicyEffect(input.resource);
      const policyDeny = await denyForAssignmentPolicyIfNeeded(policyEffect);
      if (policyDeny) return policyDeny;
      if (policyEffect.kind === "restricted") {
        const grantDecision = await decideWithTaskAssignmentGrants("agent", actorAgentId);
        if (grantDecision.allowed) return grantDecision;
        return denyRestrictedAssignmentPolicy(policyEffect);
      }
      return allow({
        action: input.action,
        reason: "allow_simple_company_member",
        explanation: "Allowed by simple mode company-wide task assignment default.",
      });
    }

    if (input.action === "issue:mutate") {
      const resource = input.resource.type === "issue" ? input.resource : null;
      if (resource?.assigneeAgentId === actorAgentId) {
        return allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed because the actor owns the assigned issue.",
        });
      }
      if (!resource?.assigneeAgentId) {
        return allow({
          action: input.action,
          reason: "allow_company_agent",
          explanation: "Allowed because the issue has no agent assignee.",
        });
      }
    }
    if (
      input.action === "agent_config:update" &&
      input.resource.type === "agent" &&
      input.resource.agentId === actorAgentId
    ) {
      return allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor is updating its own agent configuration.",
      });
    }

    if (permissionKey) {
      const grantDecision = await decidePrincipalGrant({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
      if (grantDecision.allowed) return grantDecision;
    }

    if (
      (input.action === "agents:create" ||
        input.action === "agent_config:read" ||
        input.action === "agent_config:update" ||
        input.action === "tasks:manage_active_checkouts") &&
      canCreateAgentsLegacy(actorAgent)
    ) {
      return allow({
        action: input.action,
        reason: "allow_legacy_agent_creator",
        explanation: "Allowed by legacy agent creator authority.",
      });
    }

    if (
      input.action === "tasks:manage_active_checkouts" &&
      input.resource.type === "issue" &&
      input.resource.assigneeAgentId &&
      await isManagerOf(companyId, actorAgentId, input.resource.assigneeAgentId)
    ) {
      return allow({
        action: input.action,
        reason: "allow_manager_chain",
        explanation: "Allowed because the actor manages the issue assignee in the reporting chain.",
      });
    }

    return deny({
      action: input.action,
      reason: "deny_missing_grant",
      explanation: permissionKey
        ? `Missing permission: ${permissionKey}.`
        : `No agent permission mapping exists for ${input.action}.`,
    });
  }

  return {
    decide,
    decidePrincipalGrant,
  };
}
