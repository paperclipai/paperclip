import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { approvals, issueApprovals, issueRelations, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

// Minimal wakeup signature compatible with both InteractionWakeup (in
// issue-thread-interactions.ts) and the broader IssueAssignmentWakeupDeps
// wakeup. We only care that agentId + idempotencyKey are accepted.
type PrClosureWakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_commented";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    allowRunCoalescing?: boolean;
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

type ClosedPrHint = {
  companyId: string;
  owner: string;
  repo: string;
  number: number;
};

export type GitHubPrClosureSweepResult = {
  checked: number;
  cancelled: number;
  issuesRouted: number;
  woken: number;
};

/**
 * When a PR is closed without merging, any pending board approval cards that
 * reference that PR are stale: the code they approved is no longer heading
 * toward main.  This sweep:
 *   1. Cancels those approval cards.
 *   2. Finds Paperclip tasks linked to those cards via issueApprovals.
 *   3. Adds a comment on each waiting task and moves it to todo.
 *   4. Wakes the assignee so they can re-open a PR and restart the flow.
 */
export function githubPrClosureSweepService(
  db: Db,
  opts: {
    wakeup?: PrClosureWakeup;
    now?: () => Date;
  } = {},
) {
  const now = opts.now ?? (() => new Date());
  const issues_ = issueService(db);

  return {
    sweepClosedWithoutMergedPrApprovals: async (
      hints: ClosedPrHint[] = [],
    ): Promise<GitHubPrClosureSweepResult> => {
      if (hints.length === 0) return { checked: 0, cancelled: 0, issuesRouted: 0, woken: 0 };

      const companiesByHint = new Map<string, ClosedPrHint[]>();
      for (const hint of hints) {
        const list = companiesByHint.get(hint.companyId) ?? [];
        list.push(hint);
        companiesByHint.set(hint.companyId, list);
      }

      let totalChecked = 0;
      let totalCancelled = 0;
      let totalIssuesRouted = 0;
      let totalWoken = 0;

      for (const [companyId, companyHints] of companiesByHint) {
        // Find pending board approval cards whose payload.prs array contains
        // at least one of the closed PRs. The payload.prs format is:
        //   [{repo: "owner/repo", number: 123, sha: "..."}]
        const prOrConditions = companyHints.map((hint) =>
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${approvals.payload}->'prs') = 'array'
                   THEN ${approvals.payload}->'prs'
                   ELSE '[]'::jsonb
              END
            ) AS pr
            WHERE (pr->>'repo') ILIKE ${hint.owner + "/" + hint.repo}
              AND (pr->>'number') ~ '^[0-9]+$'
              AND (pr->>'number')::int = ${hint.number}
          )`,
        );
        const prMatchCondition = prOrConditions.length === 1
          ? prOrConditions[0]!
          : sql`(${prOrConditions.reduce((acc, cond) => sql`${acc} OR ${cond}`)})`;

        const matchingApprovals = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, companyId),
              eq(approvals.status, "pending"),
              eq(approvals.type, "request_board_approval"),
              prMatchCondition,
            ),
          );

        totalChecked += matchingApprovals.length;
        if (matchingApprovals.length === 0) continue;

        const approvalIds = matchingApprovals.map((a) => a.id);
        const prLabel = companyHints
          .map((h) => `${h.owner}/${h.repo}#${h.number}`)
          .join(", ");

        // Cancel all matching approval cards. Guard against a concurrent
        // human decision landing in the same window.
        const cancelledAt = now();
        const cancelledApprovals = await db
          .update(approvals)
          .set({
            status: "cancelled",
            decisionNote: `PR closed without merging (${prLabel}). Automatically cancelled by system.`,
            decidedAt: cancelledAt,
            updatedAt: cancelledAt,
          })
          .where(
            and(
              inArray(approvals.id, approvalIds),
              eq(approvals.status, "pending"),
            ),
          )
          .returning({ id: approvals.id });

        totalCancelled += cancelledApprovals.length;
        if (cancelledApprovals.length === 0) continue;

        const cancelledIds = cancelledApprovals.map((a) => a.id);

        // Find tasks linked to those cancelled cards that are still waiting.
        // Enforce company scope so a cross-company approval link (data anomaly)
        // cannot route tasks in another company. Deduplicate by issue id to
        // avoid double-processing when two cards link to the same task.
        const linkedIssuesRaw = await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issueApprovals)
          .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
          .where(
            and(
              inArray(issueApprovals.approvalId, cancelledIds),
              eq(issues.companyId, companyId),
              inArray(issues.status, ["in_review", "blocked"]),
            ),
          );

        const seenIssueIds = new Set<string>();
        const linkedIssues = linkedIssuesRaw.filter((i) => {
          if (seenIssueIds.has(i.id)) return false;
          seenIssueIds.add(i.id);
          return true;
        });

        if (linkedIssues.length === 0) continue;

        const commentBody = [
          "**PR closed without merging — approval card cancelled**",
          "",
          `The PR(s) referenced by this task's pending approval card (${prLabel}) ` +
          "were closed without merging. The approval card has been automatically cancelled.",
          "",
          "Re-open or create a new PR and file a new approval card to continue.",
        ].join("\n");

        for (const issue of linkedIssues) {
          // Add an explanatory comment. Uses a system actor with no runId so
          // the call skips the transaction-serialization path.
          try {
            await issues_.addComment(
              issue.id,
              commentBody,
              { runId: null },
              { authorType: "system" },
            );
          } catch (err) {
            logger.warn({ err, issueId: issue.id }, "github-pr-closure-sweep: comment failed");
          }

          // Move the task back to todo so the assignee can pick it up again.
          // Skip the status change if the task is blocked for other reasons too.
          try {
            let skipStatusChange = false;
            if (issue.status === "blocked") {
              const otherBlockers = await db
                .select({ id: issueRelations.id })
                .from(issueRelations)
                .innerJoin(issues, eq(issueRelations.issueId, issues.id))
                .where(
                  and(
                    eq(issueRelations.relatedIssueId, issue.id),
                    eq(issueRelations.type, "blocks"),
                    notInArray(issues.status, ["done", "cancelled"]),
                  ),
                )
                .limit(1);
              skipStatusChange = otherBlockers.length > 0;
            }
            if (!skipStatusChange) {
              await db
                .update(issues)
                .set({ status: "todo", updatedAt: now() })
                .where(
                  and(
                    eq(issues.id, issue.id),
                    inArray(issues.status, ["in_review", "blocked"]),
                  ),
                );
              totalIssuesRouted += 1;
            }
          } catch (err) {
            logger.warn({ err, issueId: issue.id }, "github-pr-closure-sweep: status update failed");
          }

          // Wake the assignee so they are notified promptly.
          if (opts.wakeup && issue.assigneeAgentId) {
            try {
              await opts.wakeup(issue.assigneeAgentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_commented",
                payload: {
                  issueId: issue.id,
                  mutation: "pr_closed_without_merge",
                  prLabel,
                },
                idempotencyKey: `pr-closed-sweep:${issue.id}:${prLabel}`,
                allowRunCoalescing: false,
                requestedByActorType: "system",
                requestedByActorId: "system:pr-closed-sweep",
                contextSnapshot: {
                  issueId: issue.id,
                  taskId: issue.id,
                  wakeReason: "issue_commented",
                  source: "pr_closed_sweep",
                },
              });
              totalWoken += 1;
            } catch (err) {
              logger.warn(
                { err, issueId: issue.id, agentId: issue.assigneeAgentId },
                "github-pr-closure-sweep: wakeup failed",
              );
            }
          }
        }
      }

      return {
        checked: totalChecked,
        cancelled: totalCancelled,
        issuesRouted: totalIssuesRouted,
        woken: totalWoken,
      };
    },
  };
}
