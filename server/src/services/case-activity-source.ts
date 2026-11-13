import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { activityLog, caseEvents, cases, type Db } from "@paperclipai/db";

/** Exact case identifiers are useful to operators; UUIDs remain valid links. */
export function activityEntityIdCondition(entityType: string | undefined, entityId: string) {
  const id = entityId.trim();
  if (entityType !== "case") return eq(activityLog.entityId, id);
  return or(eq(activityLog.entityId, id), sql<boolean>`exists (
    select 1 from ${cases} where ${cases.id}::text = ${activityLog.entityId}
      and ${cases.companyId} = ${activityLog.companyId}
      and ${cases.identifier} = ${id.toUpperCase()}
  )`)!;
}

/**
 * These case mutations have always been stored only in case_events. Handoffs
 * and document revisions already write activity_log and must not appear twice.
 * Keep the original event ID/time so audit cursors remain stable across reads.
 */
const CASE_ONLY_EVENT_KINDS = [
  "created", "updated", "fields_changed", "status_changed", "issue_linked",
  "issue_unlinked", "child_linked", "attachment_added", "label_added", "label_removed",
];

export function caseAwareActivitySource(db: Db, companyId: string) {
  return unionAll(
    db.select(getTableColumns(activityLog)).from(activityLog)
      .where(eq(activityLog.companyId, companyId)),
    db.select({
      id: caseEvents.id,
      companyId: caseEvents.companyId,
      actorType: caseEvents.actorType,
      actorId: sql<string>`coalesce(${caseEvents.actorAgentId}::text, ${caseEvents.actorUserId}, 'system')`.as("actor_id"),
      action: sql<string>`'case.' || ${caseEvents.kind}`.as("action"),
      entityType: sql<string>`'case'`.as("entity_type"),
      entityId: sql<string>`${caseEvents.caseId}::text`.as("entity_id"),
      agentId: caseEvents.actorAgentId,
      runId: caseEvents.runId,
      responsibleUserId: sql<string | null>`null::text`.as("responsible_user_id"),
      details: caseEvents.payload,
      createdAt: caseEvents.createdAt,
    }).from(caseEvents).where(and(
      eq(caseEvents.companyId, companyId),
      inArray(caseEvents.kind, CASE_ONLY_EVENT_KINDS),
    )),
  ).as("activity_log");
}
