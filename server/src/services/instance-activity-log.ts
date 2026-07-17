import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { instanceActivityLog } from "@paperclipai/db";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";

export type InstanceActorType = "user" | "agent" | "system" | "pre_auth";

export interface InstanceActor {
  actorType: InstanceActorType;
  actorId: string;
  actorSource: string | null;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
}

export interface LogInstanceActivityInput extends Partial<InstanceActor> {
  actorType: InstanceActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Map the authenticated request actor onto the instance audit stream's actor
 * model. Unauthenticated callers (dev-server restart in local_trusted,
 * smoke-lab OAuth, bootstrap/cli-auth) are modeled explicitly as `pre_auth`
 * rather than being dropped or faked as a user.
 */
export function instanceActorFromRequest(req: Request): InstanceActor {
  const actor = req.actor;
  if (!actor || actor.type === "none") {
    return {
      actorType: "pre_auth",
      actorId: "unauthenticated",
      actorSource: "unauthenticated",
      agentId: null,
      runId: null,
      responsibleUserId: null,
    };
  }
  if (actor.type === "agent") {
    return {
      actorType: "agent",
      actorId: actor.agentId ?? "unknown-agent",
      actorSource: actor.source === "agent_jwt" ? "agent_jwt" : "agent_key",
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      responsibleUserId: actor.onBehalfOfUserId?.trim() || null,
    };
  }
  const userId = actor.userId?.trim() || null;
  return {
    actorType: "user",
    actorId: userId ?? "board",
    actorSource: actor.source ?? "session",
    agentId: null,
    runId: actor.runId ?? null,
    responsibleUserId: userId,
  };
}

/** Adapt a `getActorInfo()` result for the instance stream. */
export function instanceActorFromActorInfo(actor: {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  actorSource?: string;
}): InstanceActor {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorSource: actor.actorSource ?? null,
    agentId: actor.agentId,
    runId: actor.runId,
    responsibleUserId:
      actor.actorType === "user" && actor.actorId !== "board" ? actor.actorId : null,
  };
}

/**
 * Durable instance-scoped audit write. Same details sanitization as the
 * company-scoped `logActivity`, but no FK coupling: rows survive deletion of
 * any company/agent/run they reference.
 */
export async function logInstanceActivity(db: Db, input: LogInstanceActivityInput): Promise<void> {
  // Route tests exercise handlers with lightweight db doubles; skip the audit
  // write unless this is a real database handle (same precedent as the
  // plugin-audit company resolution guard).
  const handle = db as { insert?: unknown; select?: unknown } | null | undefined;
  if (!handle || typeof handle.insert !== "function" || typeof handle.select !== "function") return;
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  await db.insert(instanceActivityLog).values({
    actorType: input.actorType,
    actorId: input.actorId,
    actorSource: input.actorSource ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    companyId: input.companyId ?? null,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    responsibleUserId: input.responsibleUserId ?? null,
    details: redactedDetails,
  });
}
