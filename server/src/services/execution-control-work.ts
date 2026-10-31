import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { adapterAuthSessions, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { type DeliveryQueue } from "./delivery-work-notifications.js";
import { EXECUTION_RECONCILIATION_INTERVAL_MS } from "./execution-control-deadline.js";
import { obsoleteExecutionConversationHold, unresolvedExecutionDispositions } from "./execution-recovery-resolution.js";
import { TERMINAL_LOCAL_STATES, TERMINAL_RETENTION_MS } from "./local-ai-login.js";
import { nativeReplacementPending } from "./native-runtime/native-safe-replacement.js";

export function registerExecutionControlWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  duties: ReadonlyArray<{
    queue: DeliveryQueue;
    run: () => Promise<unknown>;
    next: () => Promise<number | null>;
    onSettled?: () => void;
  }>,
  canRun: () => boolean = () => true,
) {
  const workers = duties.map(duty => {
    let requested = 1;
    let reconciled = 0;
    let next: number | null = null;
    let earliestRunAt = 0;
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
      hasPending: async () => reconciled !== requested,
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
      const [native, legacy] = await Promise.all([
        db.select({ at: nativeRunFinalizations.controlDeadlineAt }).from(nativeRunFinalizations)
          .where(isNotNull(nativeRunFinalizations.controlDeadlineAt)).orderBy(asc(nativeRunFinalizations.controlDeadlineAt)).limit(1),
        db.select({ at: heartbeatRuns.executionControlDeadlineAt }).from(heartbeatRuns)
          .where(isNotNull(heartbeatRuns.executionControlDeadlineAt)).orderBy(asc(heartbeatRuns.executionControlDeadlineAt)).limit(1),
      ]);
      return deadline([native[0]?.at, legacy[0]?.at]);
    },
    async workspaceRecovery() {
      const at = await nextWorkspaceRecoveryAt(db);
      return at === null ? null : deadline([new Date(at)]);
    },
    async replacement() {
      const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
        .where(nativeReplacementPending()).limit(1);
      return rows.length ? retry() : null;
    },
    async continuation() {
      const rows = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      )).limit(1);
      return rows.length ? retry() : null;
    },
    async status() {
      const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(isNotNull(heartbeatRuns.executionStatusDeliveryId)).limit(1);
      return rows.length ? retry() : null;
    },
    async disposition() {
      const [conversation, execution] = await Promise.all([
        db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(obsoleteExecutionConversationHold()).limit(1),
        unresolvedExecutionDispositions(db, 1),
      ]);
      return conversation.length || execution.length ? retry() : null;
    },
    async localLogin() {
      // Two deadlines wake this worker: the next live attempt's expiry, and the
      // next terminal row's reclamation. The reclamation deadline matters because
      // a terminal row has `expires_at = NULL`, so the expiry scan alone would
      // return no future run and the row could linger until another login or a
      // restart.
      const [expiring, reclaiming] = await Promise.all([
        db.select({ at: adapterAuthSessions.expiresAt }).from(adapterAuthSessions).where(and(
          eq(adapterAuthSessions.connectionMethod, "local_subscription"), isNotNull(adapterAuthSessions.expiresAt),
        )).orderBy(asc(adapterAuthSessions.expiresAt)).limit(1),
        db.select({ finishedAt: adapterAuthSessions.finishedAt }).from(adapterAuthSessions).where(and(
          eq(adapterAuthSessions.connectionMethod, "local_subscription"),
          isNull(adapterAuthSessions.expiresAt),
          isNull(adapterAuthSessions.providerLeaseId),
          inArray(adapterAuthSessions.status, [...TERMINAL_LOCAL_STATES]),
          isNotNull(adapterAuthSessions.finishedAt),
        )).orderBy(asc(adapterAuthSessions.finishedAt)).limit(1),
      ]);
      const reclaimAt = reclaiming[0]?.finishedAt
        ? new Date(reclaiming[0].finishedAt.getTime() + TERMINAL_RETENTION_MS)
        : null;
      return deadline([expiring[0]?.at, reclaimAt]);
    },
  };
}
