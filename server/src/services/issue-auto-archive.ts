import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type AutoArchiveResult = {
  cancelledArchived: number;
  reviewArchived: number;
  mergedBranchArchived: number;
  total: number;
};

export function buildIssueAutoArchiveService(db: Db) {
  async function archiveCancelledIssues(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - TWO_DAYS_MS);
    const candidates = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.status, "cancelled"),
          isNull(issues.hiddenAt),
          isNotNull(issues.cancelledAt),
          lt(issues.cancelledAt, cutoff),
        ),
      );
    if (candidates.length === 0) return 0;
    const ids = candidates.map((r) => r.id);
    const hiddenAt = now;
    await db
      .update(issues)
      .set({ hiddenAt, updatedAt: now })
      .where(inArray(issues.id, ids));
    return ids.length;
  }

  async function archiveReviewIssues(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - TWO_DAYS_MS);
    const candidates = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          or(
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation),
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueProductivityReview),
          )!,
          isNull(issues.hiddenAt),
          lt(issues.createdAt, cutoff),
          // Only archive idle/completed review issues; never archive ones actively being worked on
          notInArray(issues.status, ["in_progress", "blocked", "in_review"]),
        ),
      );
    if (candidates.length === 0) return 0;
    const ids = candidates.map((r) => r.id);
    const hiddenAt = now;
    await db
      .update(issues)
      .set({ hiddenAt, updatedAt: now })
      .where(inArray(issues.id, ids));
    return ids.length;
  }

  async function archiveMergedBranchIssues(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - THREE_DAYS_MS);
    // Issues whose execution workspace is a git worktree that has been archived
    // (branch merged) for more than 3 days.
    const candidates = await db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(
        executionWorkspaces,
        and(
          eq(executionWorkspaces.id, issues.executionWorkspaceId!),
          eq(executionWorkspaces.providerType, "git_worktree"),
          eq(executionWorkspaces.status, "archived"),
          isNotNull(executionWorkspaces.closedAt),
          lt(executionWorkspaces.closedAt, cutoff),
        )!,
      )
      .where(isNull(issues.hiddenAt));
    if (candidates.length === 0) return 0;
    const ids = candidates.map((r) => r.id);
    const hiddenAt = now;
    await db
      .update(issues)
      .set({ hiddenAt, updatedAt: now })
      .where(inArray(issues.id, ids));
    return ids.length;
  }

  async function tick(now: Date = new Date()): Promise<AutoArchiveResult> {
    const [cancelledArchived, reviewArchived, mergedBranchArchived] = await Promise.all([
      archiveCancelledIssues(now).catch((err: unknown) => {
        logger.error({ err }, "issue-auto-archive: archiveCancelledIssues failed");
        return 0;
      }),
      archiveReviewIssues(now).catch((err: unknown) => {
        logger.error({ err }, "issue-auto-archive: archiveReviewIssues failed");
        return 0;
      }),
      archiveMergedBranchIssues(now).catch((err: unknown) => {
        logger.error({ err }, "issue-auto-archive: archiveMergedBranchIssues failed");
        return 0;
      }),
    ]);
    return {
      cancelledArchived,
      reviewArchived,
      mergedBranchArchived,
      total: cancelledArchived + reviewArchived + mergedBranchArchived,
    };
  }

  return { tick, archiveCancelledIssues, archiveReviewIssues, archiveMergedBranchIssues };
}

export type IssueAutoArchiveService = ReturnType<typeof buildIssueAutoArchiveService>;
