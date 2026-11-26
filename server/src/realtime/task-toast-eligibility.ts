import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { extractUserMentionIds, type LiveEvent } from "@paperclipai/shared";
import { touchedByUserCondition } from "../services/issue-participation.js";

const TASK_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);
const RUN_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

/** Relevance only: the caller must authorize the event before invoking this. */
export async function taskToastEligible(db: Db, event: LiveEvent, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { payload, companyId } = event;
  let issueId: string | null = null;
  if (event.type === "activity.logged" && payload.entityType === "issue" && TASK_ACTIONS.has(String(payload.action))) {
    issueId = typeof payload.entityId === "string" ? payload.entityId : null;
  } else if (event.type === "heartbeat.run.status" && RUN_STATUSES.has(String(payload.status))) {
    if (typeof payload.runId !== "string") return false;
    const [run] = await db.select({ issueId: heartbeatRuns.issueId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, payload.runId))).limit(1);
    issueId = run?.issueId ?? null;
  }
  if (!issueId) return false;

  const [issue] = await db.select({
    description: issues.description,
  }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
  if (!issue) return false;
  if (extractUserMentionIds(issue.description ?? "").includes(userId)) return true;
  // Keep the correlated predicate in WHERE, as in Mine. Drizzle strips table
  // qualifiers from SQL selections, which would bind inner IDs incorrectly.
  const [participation] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId), touchedByUserCondition(companyId, userId),
  )).limit(1);
  if (participation) return true;

  // Match a complete link for this exact viewer in PostgreSQL. The existing
  // body_search GIN trigram index supports this regex; LIMIT 1 bounds the
  // history returned to each connection instead of parsing every comment.
  const exactId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const href = `user://(?:[^/\\s?#)]+@)?${exactId}|user:///+${exactId}`;
  const mentionLink = `\\[[^\\]]*\\]\\((?:${href})(?:[?#][^\\s)]*)?\\)`;
  const [comment] = await db.select({ body: issueComments.body }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    isNull(issueComments.deletedAt), sql`${issueComments.body} ~ ${mentionLink}`,
  )).limit(1);
  return !!comment && extractUserMentionIds(comment.body).includes(userId);
}
