import type { Request, Response } from "express";
import type { PermissionKey, ProjectPermissionKey, SecretBindingTargetType } from "@paperclipai/shared";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { responsibleUserAuthzShadowMode } from "../services/authorization.js";

function throwOrShadowResponsibleUserCompanyAccessDeny(
  req: Request,
  companyId: string,
  code: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE",
  message: string,
) {
  logger.warn({
    authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
    code,
    action: "company_access",
    companyId,
    actorAgentId: req.actor.agentId ?? null,
    responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    method: req.method,
  }, "responsible-user company access intersection denied");
  if (responsibleUserAuthzShadowMode()) return;
  throw new HttpError(403, message, { code });
}

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "agent" && req.actor.onBehalfOfUserId?.trim()) {
    const membership = req.actor.onBehalfOfMemberships?.find(
      (item) => item.companyId === companyId && item.status === "active",
    );
    if (!membership) {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAVAILABLE",
        "Responsible user is unavailable for this company",
      );
      return;
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && membership.membershipRole === "viewer") {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAUTHORIZED",
        "Responsible user is not authorized for write access",
      );
    }
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

/**
 * Non-throwing access check for routes that look up a resource by id
 * before responding. Prefer this over `assertCompanyAccess` whenever the
 * route can reach the access check only after a successful `getById`
 * (i.e. after confirming the resource exists).
 *
 * Using `assertCompanyAccess` in that position leaks resource existence
 * across tenants: a 404 means "no such resource" while a 403 means "exists
 * in another tenant". Any authenticated user can enumerate IDs and
 * distinguish the two responses.
 *
 * Most routes should use `getAccessibleResource` below, which wraps the
 * whole pattern. When composing manually (bespoke not-found responses),
 * the shape is:
 *
 *     const issue = await svc.getById(id);
 *     if (!issue || !hasCompanyAccess(req, issue.companyId)) {
 *       res.status(404).json({ error: "Issue not found" });
 *       return;
 *     }
 *
 * so both "does not exist" and "exists but cross-tenant" return the same
 * 404, removing the oracle.
 *
 * Note: this intentionally does not replicate the write-path membership
 * checks in `assertCompanyAccess` (active membership, viewer read-only).
 * Routes that need those checks for authorized tenants should still call
 * `assertCompanyAccess` after the 404 gate — the oracle concern is only
 * about the existence check.
 *
 * The company-scope semantics must stay in lockstep with
 * `assertCompanyAccess`: in particular, signed-in instance admins do NOT
 * get blanket access to companies they are not a member of.
 */
export function hasCompanyAccess(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") return req.actor.companyId === companyId;
  if (req.actor.source === "local_implicit") return true;
  return (req.actor.companyIds ?? []).includes(companyId);
}

/**
 * Preferred way to fetch a company-scoped resource by id inside a route
 * handler. Wraps the two-step pattern described on `hasCompanyAccess` so
 * new routes cannot accidentally reintroduce the existence oracle:
 *
 *   - missing resource          → 404 `{ error: notFoundMessage }`, returns null
 *   - exists but cross-tenant   → identical 404, returns null
 *   - accessible                → runs `assertCompanyAccess` (write-path
 *     membership checks on non-safe methods) and returns the resource
 *
 * Usage:
 *
 *     const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
 *     if (!goal) return;
 *
 * Routes with bespoke not-found behavior (legacy `200 []` contracts,
 * audit-logged denials) should still compose `hasCompanyAccess` directly.
 */
export async function getAccessibleResource<T extends { companyId: string }>(
  req: Request,
  res: Response,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T | null> {
  const resolved = await resource;
  if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  assertCompanyAccess(req, resolved.companyId);
  return resolved;
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    sessionId: string | null;
    agentId: null;
    runId: string | null;
    agentApiKeyId: null;
    actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  }
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    const actorSource = req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key";
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      agentApiKeyId: req.actor.keyId ?? null,
      actorSource,
    };
  }

  const actorSource =
    req.actor.source === "local_implicit" ||
      req.actor.source === "board_key" ||
      req.actor.source === "cloud_tenant"
      ? req.actor.source
      : "session";

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    sessionId: req.actor.sessionId ?? null,
    agentId: null,
    runId: req.actor.runId ?? null,
    agentApiKeyId: null,
    actorSource,
  };
}

/**
 * The actor-scoped fields of a secret-binding context, keyed to a caller-supplied
 * consumer identity. Structurally matches `SecretConsumerContext` in
 * `services/secrets.ts` (whose types are not exported), so the return value slots
 * into `resolveAdapterConfigForRuntime`'s 3rd argument
 * (`Omit<SecretBindingContext, "configPath">`) unchanged.
 */
export type ActorSecretContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  actorType: "agent" | "user";
  actorId: string | null;
  actorSource: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
  responsibleUserId: string | null;
};

/**
 * Build the actor-scoped portion of a secret-binding context from `req.actor`,
 * taking the consumer identity as parameters. The responsible user is derived
 * server-side (`req.actor.userId ?? req.actor.onBehalfOfUserId ?? null`) and is
 * never request-body-controllable; a `null` result surfaces downstream as the
 * intended `responsible_user_missing` loud failure for a required user secret.
 *
 * `consumerType` is a parameter (not hardcoded `"agent"`) so callers can record an
 * honest consumer — `agent` for a persisted agent, `environment`/`system` for a
 * prospective config with no persisted consumer.
 *
 * Never sets `configPath` (the resolver injects it) or `allowedBindingIds`.
 */
export function buildActorSecretContext(
  req: Request,
  params: { consumerType: SecretBindingTargetType; consumerId: string },
): ActorSecretContext {
  const info = getActorInfo(req);
  return {
    consumerType: params.consumerType,
    consumerId: params.consumerId,
    actorType: info.actorType,
    actorId: info.actorId,
    actorSource: info.actorSource,
    responsibleUserId: req.actor.userId ?? req.actor.onBehalfOfUserId ?? null,
  };
}

type AccessChecker = {
  canUser: (companyId: string, userId: string | null | undefined, permissionKey: PermissionKey) => Promise<boolean>;
  hasPermission: (companyId: string, principalType: "user" | "agent", principalId: string, permissionKey: PermissionKey) => Promise<boolean>;
};

/**
 * Shared RBAC enforcement: checks company access then verifies the actor
 * (board user or agent) holds the given permission grant.
 * local_implicit and instance_admin actors bypass the permission check.
 */
export async function requirePermission(
  req: Request,
  access: AccessChecker,
  companyId: string,
  permissionKey: PermissionKey,
) {
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await access.hasPermission(companyId, "agent", req.actor.agentId, permissionKey);
    if (!allowed) throw forbidden(`Missing permission: ${permissionKey}`);
    return;
  }
  if (req.actor.type !== "board") throw unauthorized();
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const allowed = await access.canUser(companyId, req.actor.userId, permissionKey);
  if (!allowed) throw forbidden(`Missing permission: ${permissionKey}`);
}

type ProjectAccessChecker = {
  isCompanyOwner: (companyId: string, userId: string | null | undefined) => Promise<boolean>;
  hasProjectPermission: (projectId: string, principalType: "user" | "agent", principalId: string, permissionKey: ProjectPermissionKey) => Promise<boolean>;
  canUserAccessProject: (projectId: string, userId: string | null | undefined) => Promise<boolean>;
  getProjectMembership: (projectId: string, principalType: "user" | "agent", principalId: string) => Promise<unknown>;
  isAgentAssignedToProject: (projectId: string, agentId: string) => Promise<boolean>;
};

/**
 * Checks company access, then verifies the actor holds the given project-level
 * permission.  Company owners bypass the project permission check.
 */
export async function requireProjectPermission(
  req: Request,
  access: ProjectAccessChecker,
  companyId: string,
  projectId: string,
  permissionKey: ProjectPermissionKey,
) {
  assertCompanyAccess(req, companyId);

  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (await access.isCompanyOwner(companyId, req.actor.userId)) return;
    const allowed = await access.hasProjectPermission(projectId, "user", req.actor.userId!, permissionKey);
    if (!allowed) throw forbidden(`Missing project permission: ${permissionKey}`);
    return;
  }

  // Agents bypass project-level checks — they're gated by company-level
  // permissions (issues:manage, tasks:assign, etc.) and multi-tenant isolation
  // is enforced via assertCompanyAccess above (agent key is scoped to one
  // company). Project access control is for human users only.
  //
  // TODO(phase-2): Once all agents are assigned to projects via project_agents,
  // check access.isAgentAssignedToProject(projectId, agentId) here and remove
  // the blanket bypass. For now, backward-compat requires agents to reach any
  // project within their company.
  if (req.actor.type === "agent") {
    return;
  }

  throw unauthorized();
}

/**
 * Checks company access, then verifies the actor holds EITHER the company-level
 * permission OR the project-level permission (if a projectId is provided).
 *
 * This allows project members to perform actions on project issues without
 * needing the broader company-level grant.
 */
export async function requirePermissionOrProjectPermission(
  req: Request,
  access: AccessChecker & ProjectAccessChecker,
  companyId: string,
  companyPermission: PermissionKey,
  projectId: string | null | undefined,
  projectPermission: ProjectPermissionKey,
) {
  assertCompanyAccess(req, companyId);

  // Agents: check company-level permission only (project checks are for humans)
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await access.hasPermission(companyId, "agent", req.actor.agentId, companyPermission);
    if (!allowed) throw forbidden(`Missing permission: ${companyPermission}`);
    return;
  }

  if (req.actor.type !== "board") throw unauthorized();
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;

  // Try company-level permission first
  const hasCompanyPerm = await access.canUser(companyId, req.actor.userId, companyPermission);
  if (hasCompanyPerm) return;

  // Fall back to project-level permission if a project is involved
  if (projectId) {
    if (await access.isCompanyOwner(companyId, req.actor.userId)) return;
    const hasProjectPerm = await access.hasProjectPermission(projectId, "user", req.actor.userId!, projectPermission);
    if (hasProjectPerm) return;
  }

  throw forbidden(`Missing permission: ${companyPermission}${projectId ? ` or ${projectPermission}` : ""}`);
}

/**
 * Checks company access, then verifies the actor has membership in the given
 * project (no specific permission required).
 */
export async function requireProjectAccess(
  req: Request,
  access: ProjectAccessChecker,
  companyId: string,
  projectId: string,
) {
  assertCompanyAccess(req, companyId);

  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const canAccess = await access.canUserAccessProject(projectId, req.actor.userId);
    if (!canAccess) throw forbidden("No access to this project");
    return;
  }

  // Agents bypass project access checks — company membership is sufficient
  // (enforced by assertCompanyAccess above). Project-level visibility control
  // is for human users only.
  //
  // TODO(phase-2): Scope to project_agents assignment once all agents are
  // assigned to projects. See requireProjectPermission TODO.
  if (req.actor.type === "agent") {
    return;
  }

  throw unauthorized();
}
