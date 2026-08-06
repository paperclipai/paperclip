import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forceReleaseStaleIssueLock, type RevivalAction } from "../services/issue-revival.js";
import { logActivity } from "../services/activity-log.js";

/**
 * Board-only endpoints for the kanban-retry revival flow:
 * - `POST /api/issues/:id/force-release-checkout` releases a stale
 *   issue checkout / execution that is wedged on a dead run id
 *   (paperclipai/paperclip#6334). Returns the resulting issue state.
 * - `POST /api/issues/:id/retry` enqueues a fresh wakeup for the
 *   issue's assignee so the issue becomes runnable again. Implemented
 *   as `release_and_retry` plus a flip to `todo`.
 */
export function issueRevivalRoutes(db: Db) {
  const router = Router();

  router.post("/issues/:id/force-release-checkout", async (req, res) => {
    const issueId = req.params.id as string;
    const actionParam = (req.body?.action as string | undefined) ?? "release_only";
    const action: RevivalAction =
      actionParam === "release_and_retry" ||
      actionParam === "release_and_cancel" ||
      actionParam === "release_only"
        ? (actionParam as RevivalAction)
        : "release_only";

    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) return res.status(404).json({ error: "issue_not_found" });

    assertCompanyAccess(req, issue.companyId);
    assertBoard(req);

    const result = await forceReleaseStaleIssueLock(db, issueId, action);
    if (!result) return res.status(404).json({ error: "issue_not_found" });

    try {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue.force_release",
        entityType: "issue",
        entityId: issueId,
        details: {
          revivalAction: result.action,
          clearedCheckoutRunId: result.clearedCheckoutRunId,
          clearedExecutionRunId: result.clearedExecutionRunId,
          finalizeTerminalRuns: result.finalizeTerminalRuns,
          enqueuedRetryRun: result.enqueuedRetryRun,
          issueStatusAfter: result.issueStatusAfter,
        },
      });
    } catch (err) {
      logger.warn(
        { event: "issue_revival.activity_log_failed", err: (err as Error).message, issueId },
        "force-release activity log entry failed",
      );
    }

    return res.json(result);
  });

  router.post("/issues/:id/retry", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) return res.status(404).json({ error: "issue_not_found" });

    assertCompanyAccess(req, issue.companyId);
    assertBoard(req);

    const result = await forceReleaseStaleIssueLock(db, issueId, "release_and_retry");
    if (!result) return res.status(404).json({ error: "issue_not_found" });

    try {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue.retry",
        entityType: "issue",
        entityId: issueId,
        details: {
          enqueuedRetryRun: result.enqueuedRetryRun,
          clearedCheckoutRunId: result.clearedCheckoutRunId,
          clearedExecutionRunId: result.clearedExecutionRunId,
        },
      });
    } catch (err) {
      logger.warn(
        { event: "issue_revival.activity_log_failed", err: (err as Error).message, issueId },
        "retry activity log entry failed",
      );
    }
    return res.json(result);
  });

  return router;
}
