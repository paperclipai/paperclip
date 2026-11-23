import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { activeNativeExecutionRunIds, subscribeActiveNativeExecutions } from "./native-active-runs.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const notifyNativeCancellation = (tx: object) => notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeCancellation);

/** Called only when this process has neither an active handle nor a startup.
 * Expiry/release authorizes recovery, not a no-op acknowledgement: the remote
 * execution can still be alive while its next controller is attaching. */
export async function nativeCancellationHasUnsettledOwner(db: Db, runId: string): Promise<boolean> {
  if (process.env.PAPERCLIP_EPHEMERAL_SERVER !== "true") return false;
  const [owner] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.runId, runId), isNull(nativeRunFinalizations.resultId),
      inArray(heartbeatRuns.status, ["running", "queued"]))).limit(1);
  return Boolean(owner);
}

/** The accepting HTTP server waits for the real owner's audited ACK. Subscribe
 * before reading so a commit between admission and subscription cannot be lost.
 * The existing intent remains recoverable after timeout or process replacement. */
export function waitForNativeCancellation(db: Db, input: { companyId: string; runId: string; intentId: string }, timeoutMs = 20_000) {
  return new Promise<{ dispatched: true; decisionId: string | null; auditId: string }>((resolve, reject) => {
    let settled = false, reading = false, dirty = false;
    const finish = (error?: unknown, result?: { dispatched: true; decisionId: string | null; auditId: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); unsubscribe();
      if (error) reject(error); else resolve(result!);
    };
    const check = async () => {
      dirty = true;
      if (reading || settled) return;
      reading = true;
      try {
        do {
          dirty = false;
          const [run] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
          const intent = object(run?.result?.nativeCancellation);
          if (intent.intentId !== input.intentId) throw new Error("native_cancellation_intent_conflict");
          if (intent.dispatchState === "acknowledged" && intent.dispatched === true && typeof intent.acknowledgementAuditId === "string") {
            finish(undefined, { dispatched: true, decisionId: typeof intent.decisionId === "string" ? intent.decisionId : null,
              auditId: intent.acknowledgementAuditId });
          }
        } while (dirty && !settled);
      } catch (error) { finish(error); }
      finally { reading = false; }
    };
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeCancellation, event => { if (event === "settled") void check(); });
    const timeout = setTimeout(() => finish(new Error("native_cancellation_pending_recovery")), timeoutMs);
    void check();
  });
}

/** Reconcile only this controller's live executions. Intent lives on the run;
 * no idle scan, new command table, or competing execution claim is introduced. */
export function registerNativeCancellationDelivery(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) {
  const worker = coordinator.register(DELIVERY_QUEUES.nativeCancellation, {
    retryMs: 1000, runDuringDrain: true,
    async run(signal) {
      const ids = [...activeNativeExecutionRunIds];
      if (!ids.length) return;
      const identity = await currentNativeControllerIdentity();
      const rows = await db.select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson }).from(heartbeatRuns)
        .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
          inArray(heartbeatRuns.id, ids), eq(nativeRunFinalizations.controllerBootId, identity.bootId),
          gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
          sql`${heartbeatRuns.resultJson}->'nativeCancellation'->>'dispatchState' = 'pending'`,
        ));
      for (const row of rows) {
        signal.throwIfAborted();
        if (!activeNativeExecutionRunIds.has(row.id)) continue;
        const intent = object(row.result?.nativeCancellation), startup = object(row.result?.startupCancellation);
        if (intent.schema !== "paperclip.native-cancellation.v1" || !["run", "issue", "turn"].includes(String(intent.scope))) continue;
        const { cancelNativeSession } = await import("./native-session-executor.js");
        await cancelNativeSession(row.id, typeof intent.reason === "string" ? intent.reason : "Operator requested Stop", {
          db, scope: intent.scope as "run" | "issue" | "turn",
          replacementAccepted: Array.isArray(intent.effects) && intent.effects.includes("accept_replacement_turn"),
          ...(typeof startup.cancellationRequestId === "string" ? { cancellationRequestId: startup.cancellationRequestId } : {}),
        });
      }
    },
    hasPending: async () => false,
  });
  const unsubscribe = subscribeActiveNativeExecutions(worker.wake);
  return { ready: worker.ready, async stop() { unsubscribe(); await worker.stop(); } };
}
