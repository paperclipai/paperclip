import { and, eq, inArray, isNull } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { issueReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { sharedDeliveryRead, type LiveDeliveryReads } from "./live-event-delivery.js";

/** Invalidation hints disclose only parents this subscriber can read. Called
 * after task authorization; never expose raw activity details to the browser. */
export async function recentSubtaskParents(
  db: Db, actor: AuthorizationActor, companyId: string, payload: Record<string, unknown>,
  reads?: LiveDeliveryReads,
  knownTask?: { id: string; parentId: string | null },
) {
  if (payload.entityType && payload.entityType !== "issue" && payload.entityType !== "heartbeat_run") return {};
  const issueId = payload.entityType === "issue" ? payload.entityId : payload.issueId;
  if (actor.type !== "board" || typeof issueId !== "string") return {};
  // Materialize the query as one promise. A Drizzle query is a thenable and
  // would execute again when the delivery cache attaches its rejection handler.
  const task = knownTask?.id === issueId ? knownTask : (await sharedDeliveryRead(reads, `navigation-parent:${issueId}`, async () =>
    db.select({ parentId: issues.parentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1)))[0];
  const details = payload.details as Record<string, unknown> | null | undefined;
  const previous = details?._previous as Record<string, unknown> | null | undefined;
  const ids = [...new Set([task?.parentId, details?.parentId, previous?.parentId]
    .filter((id): id is string => typeof id === "string" && z.string().uuid().safeParse(id).success))];
  if (!ids.length) return { recentSubtaskParentIds: [] as string[] };
  const readable = await sharedDeliveryRead(reads, `navigation-readable:${[...ids].sort().join(",")}`, async () =>
    db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId), inArray(issues.id, ids), isNull(issues.hiddenAt),
      await issueReadSqlCondition(db, actor),
    )));
  return { recentSubtaskParentIds: readable.map(row => row.id) };
}
