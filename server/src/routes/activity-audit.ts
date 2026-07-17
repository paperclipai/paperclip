import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity, type LogActivityInput } from "../services/activity-log.js";
import { getActorInfo } from "./authz.js";

export async function logRouteActivity(
  db: Db,
  req: Request,
  input: Omit<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId">,
) {
  const actor = getActorInfo(req);
  await logActivity(db, {
    ...input,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
  });
}
