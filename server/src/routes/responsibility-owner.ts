import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { agentPersonInCompany } from "./agent-person-authz.js";

/** A dashboard belongs to the signed-in person or the person who directed this agent run. */
export async function dashboardOwner(db: Db, req: Request, companyId: string, requested?: string | null): Promise<string> {
  const userId = req.actor.type === "board"
    ? req.actor.userId
    : (await agentPersonInCompany(db, req, companyId))?.userId;
  if (!userId) throw forbidden("A personal dashboard requires a user or a run directed by that user");
  if (req.actor.authorizingUserId && req.actor.authorizingUserId !== userId) throw forbidden("Dashboard access requires the authorizing user");
  if (requested !== undefined && userId !== requested) throw notFound("Dashboard item not found");
  return userId;
}

/** Reporting permissions apply only within the user scope of the agent's credentials or run. */
export function agentMayReportFor(req: Request, ownerUserId: string) {
  return req.actor.type === "agent"
    && (!req.actor.authorizingUserId || req.actor.authorizingUserId === ownerUserId)
    && (!req.actor.onBehalfOfUserId || req.actor.onBehalfOfUserId === ownerUserId);
}
