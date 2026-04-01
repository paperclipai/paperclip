import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@ironworksai/db";
import { companyMemberships } from "@ironworksai/db";
import { forbidden, unauthorized } from "../errors.js";

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

/**
 * SEC-ADV-005: Enforce write permission for all mutation routes.
 * Viewers (membershipRole = "viewer") are read-only; agents and local_implicit
 * actors are system actors and are always allowed to write.
 */
export async function assertCanWrite(req: Request, companyId: string, db: Db): Promise<void> {
  assertCompanyAccess(req, companyId);

  // Agents and local_implicit board actors are system actors — always allow.
  if (req.actor.type === "agent") return;
  if (req.actor.type === "board" && req.actor.source === "local_implicit") return;

  // Instance admins can always write.
  if (req.actor.type === "board" && req.actor.isInstanceAdmin) return;

  // For regular board actors, check that their membership role is not "viewer".
  if (req.actor.type === "board" && req.actor.userId) {
    const userId = req.actor.userId;
    const membership = await db
      .select({ membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (membership?.membershipRole === "viewer") {
      throw forbidden("Viewers have read-only access");
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
