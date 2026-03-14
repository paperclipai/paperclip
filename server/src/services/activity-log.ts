import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails ? redactCurrentUserValue(sanitizedDetails) : null;
  const runId = input.runId ?? null;

  const values = {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId,
    details: redactedDetails,
  };

  try {
    await db.insert(activityLog).values(values);
  } catch (err: unknown) {
    // If runId references a heartbeat_run that doesn't exist (FK violation),
    // retry the insert without the runId rather than losing the activity log.
    const isFkViolation =
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "23503" &&
      runId != null;
    if (isFkViolation) {
      await db.insert(activityLog).values({ ...values, runId: null });
    } else {
      throw err;
    }
  }

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId,
      details: redactedDetails,
    },
  });
}
