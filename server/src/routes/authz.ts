import type { Request } from "express";
import type { PermissionKey, ProjectPermissionKey } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertCompanyAccess(req: Request, companyId: string) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
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
  canUserAccessProject: (companyId: string, projectId: string, userId: string | null | undefined) => Promise<boolean>;
  getProjectMembership: (projectId: string, principalType: "user" | "agent", principalId: string) => Promise<unknown>;
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

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await access.hasProjectPermission(projectId, "agent", req.actor.agentId, permissionKey);
    if (!allowed) throw forbidden(`Missing project permission: ${permissionKey}`);
    return;
  }

  throw unauthorized();
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
    const canAccess = await access.canUserAccessProject(companyId, projectId, req.actor.userId);
    if (!canAccess) throw forbidden("No access to this project");
    return;
  }

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const member = await access.getProjectMembership(projectId, "agent", req.actor.agentId);
    if (!member) throw forbidden("No access to this project");
    return;
  }

  throw unauthorized();
}
