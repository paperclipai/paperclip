import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentDelegateGrants } from "@paperclipai/db";
import { forbidden, unauthorized } from "../errors.js";

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

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export async function assertCompanyAccess(
  req: Request,
  companyId: string,
  db: Db,
  opts?: { requiredScope?: string },
) {
  assertAuthenticated(req);

  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    const agentId = req.actor.agentId;
    if (!agentId) {
      throw forbidden("Agent key cannot access another company");
    }

    const now = new Date();
    const [grant] = await db
      .select({ id: agentDelegateGrants.id, scopes: agentDelegateGrants.scopes })
      .from(agentDelegateGrants)
      .where(
        and(
          eq(agentDelegateGrants.delegateAgentId, agentId),
          eq(agentDelegateGrants.hostCompanyId, companyId),
          isNull(agentDelegateGrants.revokedAt),
          or(
            isNull(agentDelegateGrants.expiresAt),
            gt(agentDelegateGrants.expiresAt, now),
          ),
        ),
      )
      .limit(1);

    if (!grant) {
      throw forbidden("Agent key cannot access another company");
    }

    if (opts?.requiredScope) {
      if (!grant.scopes || !grant.scopes.includes(opts.requiredScope)) {
        throw forbidden(`Delegate grant does not include required scope: ${opts.requiredScope}`);
      }
    }

    req.delegateGrant = { grantId: grant.id, hostCompanyId: companyId };
    return;
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

export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      delegateGrantId: req.delegateGrant?.grantId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
    delegateGrantId: null,
  };
}
