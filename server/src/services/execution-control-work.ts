import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { adapterAuthSessions, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { type DeliveryQueue } from "./delivery-work-notifications.js";
import { EXECUTION_RECONCILIATION_INTERVAL_MS } from "./execution-control-deadline.js";
import { obsoleteExecutionConversationHold, unresolvedExecutionDispositions } from "./execution-recovery-resolution.js";
import { heldExecutionsAwaitingFreshContinuation, nextFreshContinuationCheckAt } from "./fresh-continuation-fallback.js";
import { hasPendingNativeReplacements } from "./native-runtime/native-safe-replacement.js";
import { nextAbandonedNativeOwnerReleaseAt } from "./native-runtime/native-failed-run-owner-release.js";
import { hasPendingPauseResume } from "./issue-tree-resume.js";
import { hasPendingBudgetResume } from "./budget-resume-continuation.js";

export function registerExecutionControlWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  duties: ReadonlyArray<{
    queue: DeliveryQueue;
    run: () => Promise<unknown>;
    next: () => Promise<number | null>;
    onSettled?: () => void;
    settleEmptyWhilePaused?: boolean;
  }>,
  canRun: () => boolean = () => true,
) {
  const workers = duties.map(duty => {
    let requested = 1;
    let reconciled = 0;
    let next: number | null = null;
    let earliestRunAt = 0;
    let pausedGeneration = 0, pausedPending = true;
    const worker = coordinator.register(duty.queue, {
      retryMs: EXECUTION_RECONCILIATION_INTERVAL_MS,
      pausePassiveMaintenance: true,
      onSettled: () => { requested += 1; duty.onSettled?.(); },
      run: async () => {
        if (!canRun()) { requested += 1; next = null; return; }
        const now = Date.now();
        if (now < earliestRunAt) {
          if (reconciled !== requested || (next !== null && next <= now)) next = earliestRunAt;
          return;
        }
        const generation = ++requested;
        earliestRunAt = now + EXECUTION_RECONCILIATION_INTERVAL_MS;
        await duty.run();
        const deadline = await duty.next();
        next = deadline === null ? null : Math.max(deadline, earliestRunAt);
        reconciled = generation;
      },
      hasPending: async (runAllowed = true) => {
        if (reconciled === requested) return false;
        if (runAllowed || !duty.settleEmptyWhilePaused || !canRun() || reconciled === 0) return true;
        if (pausedGeneration !== requested) {
          const generation = requested;
          const deadline = await duty.next();
          if (generation !== requested) return true;
          pausedGeneration = generation; pausedPending = deadline !== null; next = deadline;
          if (!pausedPending) reconciled = generation;
        }
        return pausedPending;
      },
      nextRunAt: () => next,
    });
    return { ...worker, wake: () => { requested += 1; worker.wake(); } };
  });
  return { ready: Promise.all(workers.map(worker => worker.ready)), wake: () => { for (const worker of workers) worker.wake(); } };
}

export function executionControlSchedule(db: Db) {
  const retry = () => Date.now() + EXECUTION_RECONCILIATION_INTERVAL_MS;
  const deadline = (dates: Array<Date | null | undefined>) => {
    const at = dates.flatMap(date => date ? [date.getTime()] : []);
    if (!at.length) return null;
    const earliest = Math.min(...at);
    return earliest > Date.now() ? earliest : retry();
  };
  return {
    async finalization() {
      const [native, legacy, abandonedOwner] = await Promise.all([
        db.select({ at: nativeRunFinalizations.controlDeadlineAt }).from(nativeRunFinalizations)
          .where(isNotNull(nativeRunFinalizations.controlDeadlineAt)).orderBy(asc(nativeRunFinalizations.controlDeadlineAt)).limit(1),
        db.select({ at: heartbeatRuns.executionControlDeadlineAt }).from(heartbeatRuns)
          .where(isNotNull(heartbeatRuns.executionControlDeadlineAt)).orderBy(asc(heartbeatRuns.executionControlDeadlineAt)).limit(1),
        nextAbandonedNativeOwnerReleaseAt(db),
      ]);
      return deadline([native[0]?.at, legacy[0]?.at, abandonedOwner]);
    },
    async workspaceRecovery() {
      const at = await nextWorkspaceRecoveryAt(db);
      return at === null ? null : deadline([new Date(at)]);
    },
    async replacement() {
      return await hasPendingNativeReplacements(db) ? retry() : null;
    },
    async continuation() {
      const rows = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      )).limit(1);
      return rows.length || await hasPendingPauseResume(db) || await hasPendingBudgetResume(db) ? retry() : null;
    },
    async status() {
      const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(isNotNull(heartbeatRuns.executionStatusDeliveryId)).limit(1);
      return rows.length ? retry() : null;
    },
    async disposition() {
      const now = new Date();
      const [conversation, execution, held, nextCheck] = await Promise.all([
        db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(obsoleteExecutionConversationHold()).limit(1),
        unresolvedExecutionDispositions(db, 1),
        heldExecutionsAwaitingFreshContinuation(db, now, 1),
        nextFreshContinuationCheckAt(db),
      ]);
      return conversation.length || execution.length || held.length ? retry() : deadline([nextCheck ? new Date(nextCheck) : null]);
    },
    async localLogin() {
      const rows = await db.select({ at: adapterAuthSessions.expiresAt }).from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.connectionMethod, "local_subscription"), isNotNull(adapterAuthSessions.expiresAt),
      )).orderBy(asc(adapterAuthSessions.expiresAt)).limit(1);
      return deadline([rows[0]?.at]);
    },
  };
}
