import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Board-level helper for `POST /api/issues/:id/force-release-checkout`
 * (paperclipai/paperclip#6334). When a heartbeat run dies while still
 * holding a `checkoutRunId` and/or `executionRunId`, the issue is
 * wedged on a dead run id. Long cleanup TTLs block the active agent
 * from advancing the issue until either the TTL expires or a human
 * releases the lock. This service forces the release.
 *
 * It is intentionally destructive: it nulls the issue's checkout and
 * execution columns AND cancels the dead run. Surface a meaningful
 * log entry + activity-log call from the caller so the operator sees
 * who did this and why.
 */

export type RevivalAction = "release_only" | "release_and_retry" | "release_and_cancel";

export interface ForceReleaseResult {
  issueId: string;
  action: RevivalAction;
  clearedCheckoutRunId: string | null;
  clearedExecutionRunId: string | null;
  finalizeTerminalRuns: string[];
  enqueuedRetryRun: string | null;
  issueStatusAfter: string;
}

export async function forceReleaseStaleIssueLock(
  db: Db,
  issueId: string,
  action: RevivalAction = "release_only",
  now: Date = new Date(),
): Promise<ForceReleaseResult | null> {
  const issue = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;

  const candidateRunIds = Array.from(
    new Set(
      [issue.checkoutRunId, issue.executionRunId].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ),
  );

  const finalized: string[] = [];
  if (candidateRunIds.length > 0) {
    const terminalCandidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          or(...candidateRunIds.map((id) => eq(heartbeatRuns.id, id)))!,
        ),
      );
    for (const run of terminalCandidates) {
      if (run.status === "queued" || run.status === "running") {
        const updated = await db
          .update(heartbeatRuns)
          .set({
            status: "failed",
            error: "Force-released by board operator (stale checkout cleanup)",
            errorCode: "force_released",
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running"))!,
            ),
          )
          .returning({ id: heartbeatRuns.id })
          .then((rows) => rows[0] ?? null);
        if (updated) finalized.push(run.id);
      }
    }
  }

  const nextStatus = action === "release_and_cancel" ? "cancelled" : issue.status;
  await db
    .update(issues)
    .set({
      status: nextStatus,
      checkoutRunId: null,
      executionRunId: null,
      updatedAt: now,
    })
    .where(eq(issues.id, issueId));

  let enqueuedRetryRun: string | null = null;
  if (action === "release_and_retry") {
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, issue.assigneeAgentId ?? "")))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (agent && agent.status !== "terminated" && agent.status !== "pending_approval") {
      const existingWake = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            eq(agentWakeupRequests.agentId, agent.id),
            eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .limit(1);
      if (existingWake.length === 0) {
        const wake = await db
          .insert(agentWakeupRequests)
          .values({
            companyId: issue.companyId,
            agentId: agent.id,
            source: "board_force_retry",
            triggerDetail: "force_release_retry",
            reason: "retry_after_force_release",
            payload: { issueId: issue.id, taskId: issue.id, taskKey: issue.identifier },
            status: "queued",
            requestedByActorType: "board",
            requestedByActorId: null,
            updatedAt: now,
          })
          .returning({ id: agentWakeupRequests.id })
          .then((rows) => rows[0] ?? null);
        if (wake) enqueuedRetryRun = wake.id;
      }
      // transition the issue back to todo so it is pickable
      await db
        .update(issues)
        .set({ status: "todo", updatedAt: now })
        .where(eq(issues.id, issueId));
    } else {
      logger.warn(
        { event: "issue_revival.no_agent_for_retry", issueId, action },
        "force-release-and-retry requested but no invokable assignee was found",
      );
    }
  }

  logger.warn(
    {
      event: "issue_revival.force_release",
      issueId,
      companyId: issue.companyId,
      action,
      clearedCheckoutRunId: issue.checkoutRunId ?? null,
      clearedExecutionRunId: issue.executionRunId ?? null,
      finalizeTerminalRuns: finalized,
      enqueuedRetryRun,
      issueStatusAfter: action === "release_and_retry" ? "todo" : nextStatus,
    },
    "board operator force-released a stale issue checkout",
  );

  return {
    issueId,
    action,
    clearedCheckoutRunId: issue.checkoutRunId ?? null,
    clearedExecutionRunId: issue.executionRunId ?? null,
    finalizeTerminalRuns: finalized,
    enqueuedRetryRun,
    issueStatusAfter: action === "release_and_retry" ? "todo" : nextStatus,
  };
}

/**
 * Marks the issue as `needs_retry` (if currently in a recoverable
 * state) without touching the checkout columns. Used by the auto-retry
 * scheduler when the retry budget is exhausted.
 */
export async function flagIssueNeedsRetry(
  db: Db,
  issueId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(issues)
    .set({
      status: "needs_retry",
      updatedAt: now,
    })
    .where(
      and(
        eq(issues.id, issueId),
        or(
          eq(issues.status, "todo"),
          eq(issues.status, "in_progress"),
          eq(issues.status, "in_review"),
          isNull(issues.checkoutRunId),
        )!,
      ),
    )
    .returning({ id: issues.id })
    .then((rows) => rows[0] ?? null);
  return Boolean(updated);
}

/**
 * Convenience wrapper used from the issue-comment-triggered retry
 * path (existing call sites). Returns the issue id, or null if no
 * issue-bound retry wakeup could be enqueued.
 */
export async function enqueueRetryWakeupForIssue(
  db: Db,
  issueId: string,
  agentId: string,
  companyId: string,
  taskKey: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const wakeup = await db
    .insert(agentWakeupRequests)
    .values({
      companyId,
      agentId,
      source: "manual_retry",
      triggerDetail: "issue_revival",
      reason: "retry_failed_run",
      payload: {
        issueId,
        taskId: issueId,
        taskKey: taskKey ?? null,
      },
      status: "queued",
      requestedByActorType: "board",
      requestedByActorId: null,
      updatedAt: now,
    })
    .returning({ id: agentWakeupRequests.id })
    .then((rows) => rows[0] ?? null);
  return wakeup?.id ?? null;
}
