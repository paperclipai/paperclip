import type { Request } from "express";
import type { PermissionKey } from "@paperclipai/shared";
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
