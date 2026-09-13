import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";

/** Only newly recorded control deadlines are eligible. Upgrades never replay ambiguous historical runs. */
export async function reconcileAbandonedExecutionControl(
  db: Db,
  now = new Date(),
) {
  const nativeDue = await db
    .select({
      runId: nativeRunFinalizations.runId,
      issueId: nativeRunFinalizations.issueId,
      companyId: nativeRunFinalizations.companyId,
    })
    .from(nativeRunFinalizations)
    .where(
      and(
        isNotNull(nativeRunFinalizations.controlDeadlineAt),
        lte(nativeRunFinalizations.controlDeadlineAt, now),
      ),
    )
    .limit(50);
  const controlDue = await db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      context: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        isNotNull(heartbeatRuns.executionControlDeadlineAt),
        lte(heartbeatRuns.executionControlDeadlineAt, now),
      ),
    )
    .limit(50);
  const due = [
    ...new Map(
      [
        ...nativeDue,
        ...controlDue.map((row) => ({
          ...row,
          issueId:
            typeof row.context?.issueId === "string"
              ? row.context.issueId
              : null,
        })),
      ].map((row) => [row.runId, row]),
    ).values(),
  ];
  let surfaced = 0;
  // Bound contention latency across independent tasks: a locked task must not
  // consume the entire reconciliation window for every task behind it.
  let nextCandidate = 0;
  await Promise.all(Array.from({ length: Math.min(5, due.length) }, async () => {
    while (nextCandidate < due.length) {
      const candidate = due[nextCandidate++]!;
      try {
        const repaired = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
          );
          const task = candidate.issueId
            ? (
                await tx
                  .select()
                  .from(issues)
                  .where(
                    and(
                      eq(issues.id, candidate.issueId),
                      eq(issues.companyId, candidate.companyId),
                    ),
                  )
                  .for("update")
              )[0]
            : null;
          const [coordinator] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(
              and(
                eq(nativeRunFinalizations.runId, candidate.runId),
                eq(nativeRunFinalizations.companyId, candidate.companyId),
              ),
            )
            .for("update");
          const [run] = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, candidate.runId),
                eq(heartbeatRuns.companyId, candidate.companyId),
              ),
            )
            .for("update");
          if (
            !run ||
            ![
              coordinator?.controlDeadlineAt,
              run.executionControlDeadlineAt,
            ].some((deadline) => deadline && deadline <= now)
          )
            return false;
          await tx
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: null })
            .where(eq(heartbeatRuns.id, run.id));
          if (
            [
              "succeeded",
              "failed",
              "cancelled",
              "timed_out",
              "interrupted",
            ].includes(run.status)
          ) {
            if (coordinator?.controlDeadlineAt)
              await tx
                .update(nativeRunFinalizations)
                .set({ controlDeadlineAt: null })
                .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          // A persisted result belongs to the existing finalizer, not a replacement provider.
          if (coordinator?.resultId) {
            await tx
              .update(nativeRunFinalizations)
              .set({
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          const cause = "execution_finalization_deadline_exceeded";
          const nextAction =
            "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
          if (coordinator)
            await tx
              .update(nativeRunFinalizations)
              .set({
                phase: "terminal_failure",
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                recoveryState: "blocked",
                nextAttemptAt: null,
                failureCode: cause,
                failureDetail: {
                  ...coordinator.failureDetail,
                  nextAction,
                  recoveryOwner: { kind: "board" },
                },
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
          await tx
            .update(heartbeatRuns)
            .set({
              status: "failed",
              executionStatusDeliveryId: randomUUID(),
              finishedAt: now,
              ...(coordinator
                ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: now }
                : {}),
              errorCode: cause,
              error: nextAction,
              nextAction,
              updatedAt: now,
            })
            .where(eq(heartbeatRuns.id, run.id));
          await tx
            .update(agents)
            .set({ status: "idle", updatedAt: now })
            .where(
              and(
                eq(agents.id, run.agentId),
                eq(agents.companyId, run.companyId),
                eq(agents.status, "running"),
                sql`not exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${run.agentId} and ${heartbeatRuns.status} = 'running')`,
              ),
            );
          const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
          const isCurrentReviewer = review?.status === "pending" &&
            review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
          if (
            !task ||
            (task.assigneeAgentId !== run.agentId && !isCurrentReviewer) ||
            ["done", "cancelled"].includes(task.status) ||
            (task.executionRunId && task.executionRunId !== run.id) ||
            (task.checkoutRunId && task.checkoutRunId !== run.id)
          )
            return true;
          await tx
            .update(issues)
            .set({ executionRunId: null, checkoutRunId: null, updatedAt: now })
            .where(eq(issues.id, task.id));
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: run.companyId,
            sourceIssueId: task.id,
            kind: "active_run_watchdog",
            ownerType: "board",
            ownerAgentId: null,
            returnOwnerAgentId: task.assigneeAgentId,
            cause,
            fingerprint: `execution-control:${run.id}`,
            evidence: {
              runId: run.id,
              ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
              originalFailureCode: coordinator?.failureCode ?? run.errorCode,
              providerOwnership: "unverified",
            },
            nextAction,
            wakePolicy: null,
            maxAttempts: 3,
            supersedeOnIdentityChange: true,
          });
          return true;
        });
        if (repaired) surfaced += 1;
      } catch {
        logger.warn(
          { runId: candidate.runId },
          "Execution finalization reconciliation remains pending; continuing with other runs",
        );
      }
    }
  }));
  return { scanned: due.length, surfaced };
}
