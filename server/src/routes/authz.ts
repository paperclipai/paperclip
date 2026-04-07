import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { principalPermissionGrants } from "@paperclipai/db";
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

/**
 * Checks whether the current actor can perform lifecycle operations
 * (pause, resume, terminate, wakeup) on a target agent.
 *
 * - Board users: always allowed (preserves existing assertBoard behavior).
 * - Agents in the same company as the target: allowed.
 * - Agents in a different company: allowed only if they hold an
 *   `agents:manage_cross_company` grant whose scope includes the target
 *   agent's company.
 */
export async function assertAgentLifecycleAccess(
  req: Request,
  targetAgent: { id: string; companyId: string },
  db: Db,
): Promise<void> {
  if (req.actor.type === "none") {
    throw unauthorized();
  }

  // Board users can always manage any agent (existing assertBoard behavior)
  if (req.actor.type === "board") {
    return;
  }

  // Agent in the same company as the target: allow (self-management, manager ops, etc.)
  if (req.actor.type === "agent" && req.actor.companyId === targetAgent.companyId) {
    return;
  }

  // Agent in a different company: check for cross-company grant on the HOME company
  if (req.actor.type === "agent" && req.actor.companyId !== targetAgent.companyId) {
    const homeCompanyId = req.actor.companyId;
    const agentId = req.actor.agentId;
    if (!homeCompanyId || !agentId) {
      throw forbidden("Agent identity incomplete");
    }

    const grants = await db
      .select({ id: principalPermissionGrants.id, scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, homeCompanyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agentId),
          eq(principalPermissionGrants.permissionKey, "agents:manage_cross_company"),
        ),
      );

    const grant = grants[0];
    if (!grant) {
      throw forbidden("No cross-company agent management permission");
    }

    const scope = grant.scope as { targetCompanyIds?: string[] } | null;
    if (!scope?.targetCompanyIds?.includes(targetAgent.companyId)) {
      throw forbidden("Target company not in authorized scope");
    }

    return;
  }

  throw forbidden("Unauthorized");
}
