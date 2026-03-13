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
  // AllCare: HIPAA audit fields
  phiAccessed?: boolean;
  patientId?: string | null;
  accessJustification?: string | null;
  delegationChain?: string[] | null;
  retentionPolicy?: "hipaa_6yr" | "standard";
  dpopJkt?: string | null;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails ? redactCurrentUserValue(sanitizedDetails) : null;
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
    // AllCare: HIPAA audit fields
    phiAccessed: input.phiAccessed ?? false,
    patientId: input.patientId ?? null,
    accessJustification: input.accessJustification ?? null,
    delegationChain: input.delegationChain ?? null,
    retentionPolicy: input.retentionPolicy ?? "hipaa_6yr",
    dpopJkt: input.dpopJkt ?? null,
  });

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
      runId: input.runId ?? null,
      details: redactedDetails,
      phiAccessed: input.phiAccessed ?? false,
      patientId: input.patientId ?? null,
    },
  });
}
