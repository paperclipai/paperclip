import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
  issueComments,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import type {
  AgentApiKeyScope,
  PermissionKey,
  PrincipalType,
  SkillTestAgentKeyScope,
  TaskBridgeAgentKeyScope,
} from "@paperclipai/shared";
import { LOW_TRUST_REVIEW_PRESET, extractAgentMentionIds, type LowTrustBoundary } from "@paperclipai/shared";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  isIssueWithinLowTrustBoundary,
  resolveCoreTrustPreset,
  type TrustPresetResolution,
} from "./trust-preset-resolver.js";
import { logger } from "../middleware/logger.js";

export type AuthorizationActor =
  {
    type: "board" | "agent" | "none";
    userId?: string | null;
    companyIds?: string[];
    memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
    onBehalfOfMemberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
    isInstanceAdmin?: boolean;
    ignoreInstanceAdmin?: boolean;
    agentId?: string | null;
    companyId?: string | null;
    keyId?: string | null;
    keyScope?: AgentApiKeyScope | null;
    runId?: string | null;
    onBehalfOfUserId?: string | null;
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
  | "skill_config:update"
  | "agent:read"
  | "agent:wake"
  | "company_scope:read"
  | "issue:comment"
  | "issue:mutate"
  | "issue:read"
  | "project:read"
  | "runtime:manage"
  | "secrets:read";

export type AuthorizationResource =
  | { type: "company"; companyId: string }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | { type: "project"; companyId: string; projectId?: string | null }
  | {
      type: "issue";
      companyId: string;
      issueId?: string | null;
      projectId?: string | null;
      parentIssueId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      originKind?: string | null;
      originId?: string | null;
      status?: string | null;
    };

export type AuthorizationDecision = {
  allowed: boolean;
  action: AuthorizationAction;
  explanation: string;
  code?: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE";
  reason:
    | "allow_low_trust_boundary"
    | "allow_local_board"
    | "allow_instance_admin"
    | "allow_explicit_grant"
    | "allow_direct_change"
    | "allow_consented_change"
    | "allow_legacy_agent_creator"
    | "allow_issue_mention_grant"
    | "allow_self"
    | "allow_company_agent"
    | "allow_company_member"
    | "allow_simple_company_member"
    | "allow_manager_chain"
    | "deny_unauthenticated"
    | "deny_company_boundary"
    | "deny_missing_membership"
    | "deny_missing_grant"
    | "deny_missing_consent"
    | "deny_no_grant"
    | "deny_policy_restricted"
    | "deny_low_trust_boundary"
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
  if (action === "agent_config:read" || action === "agent_config:update" || action === "skill_config:update") {
    return null;
  }
  if (
    action === "agent:read" ||
    action === "agent:wake" ||
    action === "company_scope:read" ||
    action === "issue:read" ||
    action === "project:read" ||
    action === "runtime:manage" ||
    action === "secrets:read"
  ) {
    return null;
  }
  if (action === "issue:comment" || action === "issue:mutate") return null;
  return action;
}

function canCreateAgentsLegacy(agent: { role: string; permissions: unknown }) {
  if (agent.role === "ceo") return true;
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
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
type LowTrustBoundaryWithCompany = LowTrustBoundary & { companyId: string };
type AgentAuthorizationRow = {
  id: string;
  companyId: string;
  role: string;
  status: string;
  reportsTo: string | null;
  permissions: Record<string, unknown> | null | undefined;
};
type ProjectAuthorizationRow = {
  id: string;
  companyId: string;
  executionWorkspacePolicy: unknown;
};
type IssueAuthorizationRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  executionPolicy: unknown;
  originKind: string | null;
  originId: string | null;
};

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

type ResponsibleUserSnapshot = {
  userId: string;
  companyId: string;
  userExists: boolean;
  activeMembership: { companyId: string; membershipRole?: string | null; status?: string } | null;
};

type ResponsibleUserActorWithMemo = AuthorizationActor & {
  __responsibleUserSnapshotMemo?: Map<string, Promise<ResponsibleUserSnapshot>>;
};

const responsibleUserSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ResponsibleUserSnapshot> }
>();

function responsibleUserSnapshotTtlMs() {
  const raw = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_CACHE_TTL_MS?.trim();
  if (!raw) return 5_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
}

export function responsibleUserAuthzShadowMode() {
  const mode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE?.trim().toLowerCase();
  const shadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW?.trim().toLowerCase();
  return mode === "shadow" || shadow === "1" || shadow === "true" || shadow === "yes";
}

function activeActorMembership(
  memberships: Array<{ companyId: string; membershipRole?: string | null; status?: string }> | null | undefined,
  companyId: string,
) {
  return memberships?.find((membership) => membership.companyId === companyId && membership.status === "active") ?? null;
}

function activeResponsibleUserCanAuthorizeIssueAction(
  action: AuthorizationAction,
  membership: ResponsibleUserSnapshot["activeMembership"],
) {
  return Boolean(
    membership &&
    membership.status === "active" &&
    membership.membershipRole !== "viewer" &&
    (action === "issue:comment" || action === "issue:mutate")
  );
}

function scopeBoolean(scope: Record<string, unknown> | null | undefined, key: string) {
  return scope?.[key] === true;
}

export function authorizationDeniedDetails(decision: AuthorizationDecision) {
  return {
    ...(decision.code ? { code: decision.code } : {}),
    reason: decision.reason,
  };
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

  async function loadResponsibleUserSnapshot(companyId: string, userId: string): Promise<ResponsibleUserSnapshot> {
    const [user, membership] = await Promise.all([
      db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);
    return {
      userId,
      companyId,
      userExists: Boolean(user),
      activeMembership: user ? membership : null,
    };
  }

  function getResponsibleUserSnapshot(input: {
    actor: AuthorizationActor;
    companyId: string;
    userId: string;
  }): Promise<ResponsibleUserSnapshot> {
    const actorWithMemo = input.actor as ResponsibleUserActorWithMemo;
    const key = `${input.companyId}:${input.userId}`;
    actorWithMemo.__responsibleUserSnapshotMemo ??= new Map();
    const requestMemo = actorWithMemo.__responsibleUserSnapshotMemo.get(key);
    if (requestMemo) return requestMemo;

    const actorMembership = activeActorMembership(input.actor.onBehalfOfMemberships, input.companyId);
    if (actorMembership) {
      const promise = Promise.resolve({
        userId: input.userId,
        companyId: input.companyId,
        userExists: true,
        activeMembership: actorMembership,
      });
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, promise);
      return promise;
    }

    const now = Date.now();
    const cached = responsibleUserSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, cached.promise);
      return cached.promise;
    }

    const ttlMs = responsibleUserSnapshotTtlMs();
    const promise = loadResponsibleUserSnapshot(input.companyId, input.userId);
    if (ttlMs > 0) {
      responsibleUserSnapshotCache.set(key, { expiresAt: now + ttlMs, promise });
      promise.catch(() => {
        if (responsibleUserSnapshotCache.get(key)?.promise === promise) {
          responsibleUserSnapshotCache.delete(key);
        }
      });
    }
    actorWithMemo.__responsibleUserSnapshotMemo.set(key, promise);
    return promise;
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
        requireStructuredScope: input.permissionKey === "tasks:assign_scope",
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

  async function loadAgent(agentId: string): Promise<AgentAuthorizationRow | null> {
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

  async function loadProject(projectId: string): Promise<ProjectAuthorizationRow | null> {
    return db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        executionWorkspacePolicy: projects.executionWorkspacePolicy,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssue(issueId: string): Promise<IssueAuthorizationRow | null> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        originKind: issues.originKind,
        originId: issues.originId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadRunPolicy(runId: string | null | undefined, companyId: string, agentId: string) {
    if (!runId) return null;
    const row = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId || row.agentId !== agentId) return null;
    const context = isPlainRecord(row.contextSnapshot) ? row.contextSnapshot : null;
    return isPlainRecord(context?.executionPolicy)
      ? { companyId: row.companyId, executionPolicy: context.executionPolicy }
      : null;
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

  async function loadResourceContext(resource: AuthorizationResource) {
    const issue = resource.type === "issue" && resource.issueId ? await loadIssue(resource.issueId) : null;
    const projectId =
      resource.type === "issue"
        ? issue?.projectId ?? resource.projectId ?? null
        : resource.type === "project"
          ? resource.projectId ?? null
          : null;
    const project = projectId ? await loadProject(projectId) : null;
    return { issue, project };
  }

  async function resolveActorTrust(input: {
    actorAgent: AgentAuthorizationRow;
    actor: AuthorizationActor;
    companyId: string;
    resource: AuthorizationResource;
  }): Promise<TrustPresetResolution> {
    const { issue, project } = await loadResourceContext(input.resource);
    const run = await loadRunPolicy(input.actor.runId, input.companyId, input.actorAgent.id);
    return resolveCoreTrustPreset({
      companyId: input.companyId,
      agent: input.actorAgent,
      project,
      issue,
      run,
    });
  }

  async function issueIdIsDescendantOf(issueId: string, rootIssueId: string, companyId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND ancestors.depth < ${LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH - 1}
      )
      SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${rootIssueId}) AS is_descendant
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    return Boolean(
      first &&
        typeof first === "object" &&
        (first as Record<string, unknown>).is_descendant === true,
    );
  }

  async function issueResourceWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    resource: Extract<AuthorizationResource, { type: "issue" }>,
  ) {
    const issue = resource.issueId ? await loadIssue(resource.issueId) : null;
    const candidate = {
      companyId: resource.companyId,
      id: issue?.id ?? resource.issueId ?? null,
      projectId: issue?.projectId ?? resource.projectId ?? null,
    };
    if (isIssueWithinLowTrustBoundary(boundary, candidate)) return true;
    if (candidate.id && boundary.rootIssueId) {
      return issueIdIsDescendantOf(candidate.id, boundary.rootIssueId, boundary.companyId);
    }
    if (!resource.parentIssueId) return false;
    const parent = await loadIssue(resource.parentIssueId);
    if (!parent) return false;
    if (
      isIssueWithinLowTrustBoundary(boundary, {
        companyId: parent.companyId,
        id: parent.id,
        projectId: parent.projectId,
      })
    ) {
      return true;
    }
    return boundary.rootIssueId
      ? issueIdIsDescendantOf(parent.id, boundary.rootIssueId, boundary.companyId)
      : false;
  }

  async function projectWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    projectId: string | null | undefined,
  ) {
    if (!projectId) return false;
    if (boundary.projectIds?.includes(projectId)) return true;
    if (!boundary.rootIssueId) return false;
    const rootIssue = await loadIssue(boundary.rootIssueId);
    return rootIssue?.companyId === boundary.companyId && rootIssue.projectId === projectId;
  }

  function agentWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    actorAgentId: string,
    targetAgentId: string | null | undefined,
  ) {
    if (!targetAgentId) return false;
    return targetAgentId === actorAgentId || Boolean(boundary.allowedAgentIds?.includes(targetAgentId));
  }

  async function decideLowTrustAccess(input: {
    actorAgentId: string;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    resolution: TrustPresetResolution;
  }): Promise<AuthorizationDecision | null> {
    if (input.resolution.kind === "standard") return null;
    if (input.resolution.kind === "denied") {
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation: input.resolution.detail,
      });
    }

    const boundary = input.resolution.boundary;
    const lowTrustDeny = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_low_trust_boundary",
        explanation,
      });
    const lowTrustAllow = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_low_trust_boundary",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "agent_config:read" ||
      input.action === "agent_config:update" ||
      input.action === "skill_config:update" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return lowTrustDeny(
        `${LOW_TRUST_REVIEW_PRESET} agents cannot use company-wide or privileged ${input.action} APIs by default.`,
      );
    }

    if (input.action === "agent:read" || input.action === "agent:wake") {
      if (input.resource.type !== "agent") {
        return lowTrustDeny("Low-trust agent action is missing an agent resource.");
      }
      return agentWithinLowTrustBoundary(boundary, input.actorAgentId, input.resource.agentId)
        ? lowTrustAllow("Allowed inside the low-trust agent boundary.")
        : lowTrustDeny("Agent is outside this low-trust boundary.");
    }

    if (input.action === "project:read") {
      const projectId =
        input.resource.type === "issue"
          ? input.resource.projectId
          : input.resource.type === "project"
            ? input.resource.projectId
            : null;
      return await projectWithinLowTrustBoundary(boundary, projectId)
        ? lowTrustAllow("Allowed inside the low-trust project boundary.")
        : lowTrustDeny("Project is outside this low-trust boundary.");
    }

    if (input.action === "issue:comment" || input.action === "issue:read" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return lowTrustDeny("Low-trust issue access is missing an issue resource.");
      }
      if (await issueResourceWithinLowTrustBoundary(boundary, input.resource)) {
        return lowTrustAllow("Allowed inside the low-trust issue boundary.");
      }
      if (
        input.action !== "issue:mutate" &&
        input.resource.issueId &&
        await agentHasMentionGrantOnIssue({
          action: input.action,
          companyId: boundary.companyId,
          issueId: input.resource.issueId,
          issueAssigneeAgentId: input.resource.assigneeAgentId ?? null,
          actorAgentId: input.actorAgentId,
        })
      ) {
        return allowIssueMentionGrant(input.action);
      }
      return lowTrustDeny("Issue is outside this low-trust boundary.");
    }

    if (input.action === "tasks:assign") {
      if (input.resource.type !== "issue") {
        return lowTrustDeny("Low-trust task assignment is missing an issue resource.");
      }
      if (!(await issueResourceWithinLowTrustBoundary(boundary, input.resource))) {
        return lowTrustDeny("Task target is outside this low-trust boundary.");
      }
      if (input.resource.assigneeUserId) {
        return lowTrustDeny("Low-trust agents cannot assign work to board users.");
      }
      if (
        input.resource.assigneeAgentId &&
        !agentWithinLowTrustBoundary(boundary, input.actorAgentId, input.resource.assigneeAgentId)
      ) {
        return lowTrustDeny("Assignee agent is outside this low-trust boundary.");
      }
      return null;
    }

    return null;
  }

  function taskBridgeScopeIds(
    scope: TaskBridgeAgentKeyScope,
    singularKey: "projectId" | "parentIssueId",
    pluralKey: "projectIds" | "parentIssueIds",
  ) {
    return [
      ...(typeof scope[singularKey] === "string" ? [scope[singularKey]] : []),
      ...(Array.isArray(scope[pluralKey]) ? scope[pluralKey] : []),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  async function parentIssueMatchesTaskBridgeBoundary(
    parentIssueId: string | null | undefined,
    companyId: string,
    allowedParentIssueIds: string[],
  ) {
    if (!parentIssueId || allowedParentIssueIds.length === 0) return false;
    if (allowedParentIssueIds.includes(parentIssueId)) return true;
    for (const rootIssueId of allowedParentIssueIds) {
      if (await issueIdIsDescendantOf(parentIssueId, rootIssueId, companyId)) return true;
    }
    return false;
  }

  async function issueMatchesTaskBridgeCreateBoundary(
    scope: TaskBridgeAgentKeyScope,
    resource: Extract<AuthorizationResource, { type: "issue" }>,
  ) {
    const allowedProjectIds = taskBridgeScopeIds(scope, "projectId", "projectIds");
    const allowedParentIssueIds = taskBridgeScopeIds(scope, "parentIssueId", "parentIssueIds");
    if (resource.projectId && allowedProjectIds.includes(resource.projectId)) return true;
    if (await parentIssueMatchesTaskBridgeBoundary(resource.parentIssueId, resource.companyId, allowedParentIssueIds)) {
      return true;
    }
    if (resource.parentIssueId && allowedProjectIds.length > 0) {
      const parent = await loadIssue(resource.parentIssueId);
      if (parent?.companyId === resource.companyId && parent.projectId && allowedProjectIds.includes(parent.projectId)) {
        return true;
      }
    }
    return false;
  }

  async function issueMatchesTaskBridgeWriteBoundary(input: {
    actorAgentId: string;
    keyId: string;
    resource: Extract<AuthorizationResource, { type: "issue" }>;
  }) {
    const issue = input.resource.issueId ? await loadIssue(input.resource.issueId) : null;
    const assigneeAgentId = issue?.assigneeAgentId ?? input.resource.assigneeAgentId ?? null;
    if (assigneeAgentId === input.actorAgentId) return true;
    const originKind = issue?.originKind ?? input.resource.originKind ?? null;
    const originId = issue?.originId ?? input.resource.originId ?? null;
    return originKind === "task_bridge" && originId === input.keyId;
  }

  async function decideTaskBridgeAccess(input: {
    actorAgentId: string;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope: TaskBridgeAgentKeyScope;
    keyId: string;
  }): Promise<AuthorizationDecision | null> {
    const denyBridge = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_scope",
        explanation,
      });
    const allowBridge = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_explicit_grant",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "agent:read" ||
      input.action === "agent:wake" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return denyBridge("Task bridge keys cannot use company-wide, peer-agent, project, runtime, or secret APIs.");
    }

    if (input.action === "tasks:assign") {
      if (input.resource.type !== "issue") {
        return denyBridge("Task bridge assignment requires an issue resource.");
      }
      if (!(await issueMatchesTaskBridgeCreateBoundary(input.scope, input.resource))) {
        return denyBridge("Task bridge key is outside its approved parent or project boundary.");
      }
      if (input.resource.assigneeUserId) {
        return denyBridge("Task bridge keys cannot assign work to board users.");
      }
      const allowedAssigneeAgentIds = input.scope.allowedAssigneeAgentIds ?? [];
      if (
        input.resource.assigneeAgentId &&
        input.resource.assigneeAgentId !== input.actorAgentId &&
        !allowedAssigneeAgentIds.includes(input.resource.assigneeAgentId)
      ) {
        return denyBridge("Task bridge key cannot assign work to that agent.");
      }
      return allowBridge("Allowed by task bridge create boundary.");
    }

    if (input.action === "issue:read" || input.action === "issue:comment" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return denyBridge("Task bridge issue access requires an issue resource.");
      }
      return await issueMatchesTaskBridgeWriteBoundary({
        actorAgentId: input.actorAgentId,
        keyId: input.keyId,
        resource: input.resource,
      })
        ? allowBridge("Allowed for bridge-created or assigned issue.")
        : denyBridge("Task bridge key can only access assigned or bridge-created issues.");
    }

    return denyBridge("Task bridge key cannot use this API action.");
  }

  function decideSkillTestAccess(input: {
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope: SkillTestAgentKeyScope;
  }): AuthorizationDecision | null {
    const denySkillTest = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_scope",
        explanation,
      });
    const allowSkillTest = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_explicit_grant",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "agent:read" ||
      input.action === "agent:wake" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read" ||
      input.action === "tasks:assign"
    ) {
      return denySkillTest("Skill-test run tokens cannot use company-wide, peer-agent, project, runtime, secret, or task-create APIs.");
    }

    if (input.action === "issue:read" || input.action === "issue:comment" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return denySkillTest("Skill-test issue access requires an issue resource.");
      }
      return input.resource.issueId === input.scope.issueId
        ? allowSkillTest("Allowed for the scoped skill-test issue.")
        : denySkillTest("Skill-test run token can only access its own harness issue.");
    }

    return denySkillTest("Skill-test run token cannot use this API action.");
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

  function commentAuthorCanGrantIssueMention(input: {
    mentionedAgentId: string;
    issueAssigneeAgentId: string | null;
    authorAgentId: string | null;
    authorUserId: string | null;
    activeAuthorUserIds: Set<string>;
  }) {
    if (input.authorAgentId) {
      if (input.authorAgentId === input.mentionedAgentId) return false;
      return input.issueAssigneeAgentId === input.authorAgentId;
    }
    if (input.authorUserId) {
      return input.activeAuthorUserIds.has(input.authorUserId);
    }
    return false;
  }

  async function agentHasMentionGrantOnIssue(input: {
    action: AuthorizationAction;
    companyId: string;
    issueId: string;
    issueAssigneeAgentId: string | null;
    actorAgentId: string;
  }) {
    const rows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.body} LIKE ${"%agent://" + input.actorAgentId + "%"}`,
      ));

    const mentionRows = rows.filter((row) => extractAgentMentionIds(row.body).includes(input.actorAgentId));
    const authorUserIds = [...new Set(mentionRows.flatMap((row) => row.authorUserId ? [row.authorUserId] : []))];
    const activeAuthorUserIds = new Set(
      authorUserIds.length === 0
        ? []
        : await db
          .select({ principalId: companyMemberships.principalId })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, authorUserIds),
          ))
          .then((memberships) => memberships.map((membership) => membership.principalId)),
    );

    for (const row of mentionRows) {
      const authorCanGrant = commentAuthorCanGrantIssueMention({
        mentionedAgentId: input.actorAgentId,
        issueAssigneeAgentId: input.issueAssigneeAgentId,
        authorAgentId: row.authorAgentId,
        authorUserId: row.authorUserId,
        activeAuthorUserIds,
      });
      if (authorCanGrant) {
        logger.info({
          actorAgentId: input.actorAgentId,
          issueId: input.issueId,
          companyId: input.companyId,
          commentId: row.id,
          grantedAction: input.action,
          grant: "issue_mention_comment",
        }, "authorized issue mention-scoped comment grant");
        return true;
      }
    }
    return false;
  }

  function allowIssueMentionGrant(action: AuthorizationAction): AuthorizationDecision {
    return allow({
      action,
      reason: "allow_issue_mention_grant",
      explanation: "Allowed by a mention-scoped issue comment grant.",
    });
  }

  async function decideBase(input: {
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

    async function decideWithAgentConfigReadGrant(
      principalType: PrincipalType,
      principalId: string,
    ): Promise<AuthorizationDecision> {
      const configureDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:configure",
        scope: input.scope,
      });
      if (configureDecision.allowed || configureDecision.reason === "deny_missing_membership") {
        return configureDecision;
      }

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:suggest-changes",
        scope: input.scope,
      });
      if (suggestDecision.allowed || configureDecision.reason === "deny_missing_grant") {
        return suggestDecision;
      }
      return configureDecision;
    }

    async function decideWithProtectedChangeGrants(
      principalType: PrincipalType,
      principalId: string,
      keys: { direct: PermissionKey; suggest: PermissionKey },
    ): Promise<AuthorizationDecision> {
      const directDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.direct,
        scope: input.scope,
      });
      if (directDecision.allowed) {
        return allow({
          action: input.action,
          reason: "allow_direct_change",
          explanation: `Allowed by direct change permission ${keys.direct}.`,
          grant: directDecision.grant,
        });
      }
      if (directDecision.reason === "deny_missing_membership") return directDecision;

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.suggest,
        scope: input.scope,
      });
      if (suggestDecision.allowed) {
        if (scopeBoolean(input.scope, "consentedChange")) {
          return allow({
            action: input.action,
            reason: "allow_consented_change",
            explanation: `Allowed by suggest permission ${keys.suggest} after accepted change consent.`,
            grant: suggestDecision.grant,
          });
        }
        return deny({
          action: input.action,
          reason: "deny_missing_consent",
          explanation: `Permission ${keys.suggest} requires accepted change consent before applying this mutation.`,
          grant: suggestDecision.grant,
        });
      }
      if (suggestDecision.reason === "deny_missing_membership") return suggestDecision;
      if (directDecision.reason === "deny_scope") return directDecision;
      if (suggestDecision.reason === "deny_scope") return suggestDecision;

      return deny({
        action: input.action,
        reason: "deny_no_grant",
        explanation: `Missing permission: ${keys.direct} or ${keys.suggest}.`,
      });
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
      // cloud_tenant actors are company-scoped by contract and must never be
      // elevated — not even via stale instance_admin rows left behind by
      // deployments that ran the pre-hardening cloud_tenant path.
      if (
        !input.actor.ignoreInstanceAdmin &&
        input.actor.source !== "cloud_tenant" &&
        (input.actor.isInstanceAdmin || await isInstanceAdmin(input.actor.userId))
      ) {
        return allow({
          action: input.action,
          reason: "allow_instance_admin",
          explanation: "Allowed because the actor is an instance admin.",
        });
      }
      // What instance-admin elevation used to give cloud tenant users is
      // replaced by company-scoped visibility: an active membership in the
      // resource company grants the same read surface a same-company agent
      // gets, and non-viewer members may mutate issues inside their company.
      // Cross-company access stays denied.
      if (input.actor.source === "cloud_tenant" && input.actor.userId) {
        const membership = await getActiveMembership(companyId, "user", input.actor.userId);
        if (membership) {
          if (
            input.action === "agent:read" ||
            input.action === "company_scope:read" ||
            input.action === "issue:read" ||
            input.action === "project:read"
          ) {
            return allow({
              action: input.action,
              reason: "allow_company_member",
              explanation: "Allowed by active cloud tenant company membership.",
            });
          }
          if (
            (input.action === "issue:comment" || input.action === "issue:mutate") &&
            membership.membershipRole !== "viewer"
          ) {
            return allow({
              action: input.action,
              reason: "allow_company_member",
              explanation: "Allowed by active cloud tenant company membership.",
            });
          }
        }
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
        if (
          input.action === "agent:read" ||
          input.action === "company_scope:read" ||
          input.action === "issue:read" ||
          input.action === "project:read" ||
          input.action === "runtime:manage" ||
          input.action === "secrets:read"
        ) {
          const membership = await getActiveMembership(companyId, "user", input.actor.userId);
          // Mirroring the tasks:assign carve-out above, viewers keep the
          // read-only visibility actions but not the privileged ones.
          const requiresNonViewer =
            input.action === "runtime:manage" || input.action === "secrets:read";
          if (membership && (!requiresNonViewer || membership.membershipRole !== "viewer")) {
            return allow({
              action: input.action,
              reason: "allow_simple_company_member",
              explanation: "Allowed by standard same-company board membership visibility.",
            });
          }
          if (membership) {
            return deny({
              action: input.action,
              reason: "deny_missing_grant",
              explanation: `Viewer membership does not grant ${input.action}.`,
            });
          }
          return deny({
            action: input.action,
            reason: "deny_missing_membership",
            explanation: `user principal ${input.actor.userId} is not an active member of company ${companyId}.`,
          });
        }
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
      if (input.action === "agent_config:read") {
        return decideWithAgentConfigReadGrant("user", input.actor.userId);
      }
      if (input.action === "agent_config:update") {
        return decideWithProtectedChangeGrants("user", input.actor.userId, {
          direct: "agents:configure",
          suggest: "agents:suggest-changes",
        });
      }
      if (input.action === "skill_config:update") {
        return decideWithProtectedChangeGrants("user", input.actor.userId, {
          direct: "skills:create",
          suggest: "skills:suggest-changes",
        });
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

    if (input.actor.keyScope?.kind === "skill_test") {
      const skillTestDecision = decideSkillTestAccess({
        action: input.action,
        resource: input.resource,
        scope: input.actor.keyScope,
      });
      if (skillTestDecision) return skillTestDecision;
    }

    if (input.actor.source === "agent_key" && input.actor.keyScope?.kind === "task_bridge") {
      const keyId = input.actor.keyId ?? null;
      if (!keyId) {
        return deny({
          action: input.action,
          reason: "deny_scope",
          explanation: "Task bridge key context is missing.",
        });
      }
      const taskBridgeDecision = await decideTaskBridgeAccess({
        actorAgentId,
        action: input.action,
        resource: input.resource,
        scope: input.actor.keyScope,
        keyId,
      });
      if (taskBridgeDecision) return taskBridgeDecision;
    }

    const lowTrustDecision = await decideLowTrustAccess({
      actorAgentId,
      action: input.action,
      resource: input.resource,
      resolution: await resolveActorTrust({
        actorAgent,
        actor: input.actor,
        companyId,
        resource: input.resource,
      }),
    });
    if (lowTrustDecision) {
      if (!lowTrustDecision.allowed) return lowTrustDecision;
      if (
        input.action === "agent:read" ||
        input.action === "agent:wake" ||
        input.action === "company_scope:read" ||
        input.action === "issue:comment" ||
        input.action === "issue:read" ||
        input.action === "project:read" ||
        input.action === "runtime:manage" ||
        input.action === "secrets:read"
      ) {
        return lowTrustDecision;
      }
    }

    if (
      input.action === "agent:read" ||
      input.action === "company_scope:read" ||
      input.action === "issue:read" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return allow({
        action: input.action,
        reason: "allow_company_agent",
        explanation: "Allowed by standard same-company agent visibility.",
      });
    }

    if (input.action === "agent:wake" && input.resource.type === "agent" && input.resource.agentId === actorAgentId) {
      return allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor is waking itself.",
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

    if (input.action === "issue:comment" || input.action === "issue:mutate") {
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
      if (
        input.action === "issue:comment" &&
        resource?.issueId &&
        await agentHasMentionGrantOnIssue({
          action: input.action,
          companyId,
          issueId: resource.issueId,
          issueAssigneeAgentId: resource.assigneeAgentId ?? null,
          actorAgentId,
        })
      ) {
        return allowIssueMentionGrant(input.action);
      }
    }
    if (
      input.action === "agent_config:update" &&
      input.resource.type === "agent" &&
      input.resource.agentId === actorAgentId &&
      !scopeBoolean(input.scope, "requiresChangeGrant")
    ) {
      return allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor is updating its own agent configuration.",
      });
    }

    if (input.action === "agent_config:read") {
      if (input.resource.type === "agent" && input.resource.agentId === actorAgentId) {
        return allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed because the actor is reading its own agent configuration.",
        });
      }
      return decideWithAgentConfigReadGrant("agent", actorAgentId);
    }

    if (input.action === "agent_config:update") {
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "agents:configure",
        suggest: "agents:suggest-changes",
      });
    }

    if (input.action === "skill_config:update") {
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "skills:create",
        suggest: "skills:suggest-changes",
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

  async function applyResponsibleUserIntersection(
    input: {
      actor: AuthorizationActor;
      action: AuthorizationAction;
      resource: AuthorizationResource;
      scope?: Record<string, unknown> | null;
    },
    agentDecision: AuthorizationDecision,
  ): Promise<AuthorizationDecision> {
    const responsibleUserId = input.actor.onBehalfOfUserId?.trim();
    if (input.actor.type !== "agent" || !responsibleUserId || !agentDecision.allowed) {
      return agentDecision;
    }

    const companyId = companyIdForResource(input.resource);
    const snapshot = await getResponsibleUserSnapshot({
      actor: input.actor,
      companyId,
      userId: responsibleUserId,
    });
    const denyCode: AuthorizationDecision["code"] =
      snapshot.userExists && snapshot.activeMembership
        ? "RESPONSIBLE_USER_UNAUTHORIZED"
        : "RESPONSIBLE_USER_UNAVAILABLE";

    const userDecision = snapshot.userExists && snapshot.activeMembership
      ? await decideBase({
          ...input,
          actor: {
            type: "board",
            userId: responsibleUserId,
            companyIds: [companyId],
            memberships: [snapshot.activeMembership],
            isInstanceAdmin: false,
            ignoreInstanceAdmin: true,
            source: "session",
          },
        })
      : deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`,
        });

    if (
      !userDecision.allowed &&
      userDecision.reason === "deny_unsupported_action" &&
      activeResponsibleUserCanAuthorizeIssueAction(input.action, snapshot.activeMembership)
    ) {
      return agentDecision;
    }

    if (userDecision.allowed) return agentDecision;

    const denied = deny({
      action: input.action,
      reason: userDecision.reason,
      code: denyCode,
      explanation:
        denyCode === "RESPONSIBLE_USER_UNAVAILABLE"
          ? `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`
          : `Responsible user ${responsibleUserId} is not authorized for ${input.action}: ${userDecision.explanation}`,
      grant: userDecision.grant,
    });

    logger.warn({
      authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
      code: denied.code,
      reason: userDecision.reason,
      action: input.action,
      resourceType: input.resource.type,
      companyId,
      actorAgentId: input.actor.agentId ?? null,
      responsibleUserId,
    }, "responsible-user authorization intersection denied");

    return responsibleUserAuthzShadowMode() ? agentDecision : denied;
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }): Promise<AuthorizationDecision> {
    const agentDecision = await decideBase(input);
    return applyResponsibleUserIntersection(input, agentDecision);
  }

  return {
    decide,
    decidePrincipalGrant,
  };
}
