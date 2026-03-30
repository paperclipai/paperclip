import type { Request } from "express";
import type { PermissionKey } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import type { accessService } from "../services/access.js";

type AccessService = ReturnType<typeof accessService>;

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
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

export async function requirePermission(
  req: Request,
  companyId: string,
  permission: PermissionKey,
  access: AccessService,
): Promise<void> {
  if (req.actor.type === "none") {
    throw unauthorized();
  }

  // Instance admins and local_implicit always pass
  if (req.actor.type === "board") {
    if (req.actor.isInstanceAdmin || req.actor.source === "local_implicit") {
      return;
    }
    const allowed = await access.canUser(companyId, req.actor.userId, permission);
    if (!allowed) {
      throw forbidden(`Missing permission: ${permission}`);
    }
    return;
  }

  if (req.actor.type === "agent") {
    const agentId = req.actor.agentId;
    if (!agentId) {
      throw forbidden("Agent identity required");
    }
    const allowed = await access.hasPermission(companyId, "agent", agentId, permission);
    if (!allowed) {
      throw forbidden(`Missing permission: ${permission}`);
    }
    return;
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
