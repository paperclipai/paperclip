import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
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

export async function assertBoardOrCeoAgent(req: Request, db: Db) {
  if (req.actor.type === "board") return;
  if (req.actor.type === "agent" && req.actor.agentId) {
    const agent = await db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, req.actor.agentId))
      .then((rows) => rows[0] ?? null);
    if (agent?.role === "ceo") return;
  }
  throw forbidden("Board or CEO agent access required");
}

export async function assertManagerOf(req: Request, db: Db, targetAgentId: string) {
  if (req.actor.type === "board") return;
  if (!req.actor.agentId) throw forbidden("Agent authentication required");

  if (req.actor.agentId === targetAgentId) return;

  const actorRow = await db
    .select({ role: agents.role })
    .from(agents)
    .where(eq(agents.id, req.actor.agentId))
    .then((rows) => rows[0] ?? null);
  if (actorRow?.role === "ceo") return;

  const visited = new Set<string>([targetAgentId]);
  let currentId: string | null = targetAgentId;
  while (currentId && !visited.has(currentId) && currentId !== req.actor.agentId) {
    visited.add(currentId);
    const manager: { reportsTo: string | null } | null = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, currentId))
      .then((rows) => rows[0] ?? null);
    if (!manager) break;
    if (manager.reportsTo === req.actor.agentId) return;
    currentId = manager.reportsTo;
  }

  throw forbidden("You are not a manager of this agent");
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
