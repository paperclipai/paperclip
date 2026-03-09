import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";
import { emitDomainEvent, type DomainEvent } from "./domain-events.js";
import { sanitizeRecord } from "../redaction.js";

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

const APPROVAL_DECISION_BY_ACTION: Record<string, "approved" | "rejected" | "revision_requested"> = {
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "approval.revision_requested": "revision_requested",
};

function deriveDomainEventsFromActivity(
  input: LogActivityInput,
  sanitizedDetails: Record<string, unknown> | null,
): DomainEvent[] {
  if (input.action === "approval.created" || input.action === "approval.resubmitted") {
    return [
      {
        type: "approval.created",
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: {
          action: input.action,
          approvalId: input.entityId,
          details: sanitizedDetails,
        },
      },
    ];
  }

  const approvalDecision = APPROVAL_DECISION_BY_ACTION[input.action];
  if (approvalDecision) {
    return [
      {
        type: "approval.decided",
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: {
          action: input.action,
          approvalId: input.entityId,
          decision: approvalDecision,
          details: sanitizedDetails,
        },
      },
    ];
  }

  if (input.action === "cost.reported") {
    return [
      {
        type: "cost_event.created",
        companyId: input.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: {
          action: input.action,
          costEventId: input.entityId,
          details: sanitizedDetails,
        },
      },
    ];
  }

  return [];
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: sanitizedDetails,
  });

  emitDomainEvent({
    type: "activity.logged",
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: sanitizedDetails,
    },
  });

  const derivedEvents = deriveDomainEventsFromActivity(input, sanitizedDetails);
  for (const event of derivedEvents) {
    emitDomainEvent(event);
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
      runId: input.runId ?? null,
      details: sanitizedDetails,
    },
  });
}
