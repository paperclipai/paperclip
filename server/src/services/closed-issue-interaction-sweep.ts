import { and, eq, gte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueThreadInteractions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { historicalQuestionCondition } from "./issue-question-context.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

const SWEEP_SOURCE = "attention.closed_issue_sweep";

/**
 * Expire pending cards that still hang on done or cancelled issues (PAP-749
 * plan §2). The status transition already runs the terminal-issue expiry, but
 * older rows predate it and some write paths skipped it, so those cards kept
 * asking for answers on closed work.
 *
 * Each issue goes through `expirePendingInteractionsForTerminalIssue`, so the
 * rules stay in one place: a cancelled issue expires every pending card, and a
 * done issue keeps its ordinary historical questions answerable. The candidate
 * query uses the same conditions, so a second run finds nothing and changes
 * nothing. It runs once per server start; it recovers durable rows and is not
 * a polling loop.
 */
export async function expirePendingInteractionsOnClosedIssues(db: Db) {
  const candidates = await db
    .selectDistinct({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issueThreadInteractions.issueId, issues.id),
      eq(issueThreadInteractions.companyId, issues.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.status, "pending"),
      or(
        eq(issues.status, "cancelled"),
        and(eq(issues.status, "done"), sql`not ${historicalQuestionCondition()}`),
      ),
    ));

  const interactions = issueThreadInteractionService(db);
  let expired = 0;
  let failed = 0;
  for (const issue of candidates) {
    const startedAt = new Date();
    let rows: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    try {
      rows = await interactions.expirePendingInteractionsForTerminalIssue(issue, {});
    } catch (err) {
      // One bad card (e.g. a legacy payload) must not strand the rest; the
      // next start retries it. Each card expires in its own transaction, so
      // earlier cards on this issue may already be closed: log those too.
      failed += 1;
      logger.warn({ err, issueId: issue.id }, "closed-issue interaction sweep failed for one issue");
      rows = await db
        .select({
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          result: issueThreadInteractions.result,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "expired"),
          gte(issueThreadInteractions.resolvedAt, startedAt),
        ));
    }
    for (const row of rows) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: SWEEP_SOURCE,
        action: "issue.thread_interaction_expired",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier ?? null,
          interactionId: row.id,
          interactionKind: row.kind,
          interactionStatus: row.status,
          source: SWEEP_SOURCE,
          result: row.result ?? null,
        },
      });
    }
    expired += rows.length;
  }
  return { issues: candidates.length, expired, failed };
}
