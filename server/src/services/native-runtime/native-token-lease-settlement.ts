import { and, eq, gt, like, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { currentControllerProcessStamp, readControllerProcess, type ControllerProcess } from "../controller-process-identity.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import { notifyRetainedNativeSessionCleanup } from "../retained-native-session-cleanup-notifications.js";
import type { LocalOwnerStamp, OwnerProof } from "../owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "../recovery/ownership-registry.js";

/**
 * Holder stamps and settle for the token-only native leases (plan Phase 2):
 * the finalizer lease (`native-finalizer:*`, 5 min) and the retained-session
 * cleanup lease (`native-cleanup:*`, 60 s).
 *
 * Both run inside one server process, but their claims used to record only a
 * random token: the controller_* columns belong to the executor and must not
 * be overwritten (the finalizer's attempt rule and restart recovery read
 * them). A holder killed mid-lease therefore kept the run waiting for the
 * whole TTL. The claim now writes `lease_holder` = this process's identity,
 * bound to the token, in the same UPDATE (no I/O: `currentControllerProcessStamp`).
 * The holder names the lease owner only while its token equals `lease_owner`,
 * so renewals keep it and any later owner never inherits it.
 *
 * Previous release: rows it saved have no holder. They stay token fences, and
 * the existing claim takes them over at expiry (at most 5 min / 60 s after the
 * upgrade, since neither lease outlives that). Settle never touches them.
 */

export type NativeTokenLeaseKind = "native_finalizer_lease" | "native_cleanup_lease";

const PREFIX: Record<NativeTokenLeaseKind, string> = {
  native_finalizer_lease: "native-finalizer:",
  native_cleanup_lease: "native-cleanup:",
};

/** The `lease_holder` value for a token-only lease claimed by this process. */
export function nativeLeaseHolder(token: string): Record<string, unknown> {
  return { token, ...currentControllerProcessStamp() };
}

/** The process holding `token`, or null when the holder was written for
 * another token (or not at all, on rows saved by the previous release). */
export function readNativeLeaseHolder(value: unknown, token: string | null | undefined): ControllerProcess | null {
  if (!token || !value || typeof value !== "object" || (value as { token?: unknown }).token !== token) return null;
  return readControllerProcess(value);
}

export function nativeLeaseHolderStamp(holder: ControllerProcess, scope: NativeTokenLeaseKind): LocalOwnerStamp {
  return {
    kind: "local", scope, generation: null, host: null, processSpace: holder.hostHash, bootId: holder.bootId,
    pid: holder.pid, processStartedAt: holder.processStartedAt, processGroupId: null,
  };
}

/**
 * Called by the shared reconciler only after `proveOwnerGone` proved the
 * recorded holder gone. Expires exactly that lease (compare-and-swap on the
 * token while it is still outstanding and still held by the proven process),
 * after announcing the work the expiry releases. It settles ownership only:
 * the finalizer or cleanup that the notification wakes does the rest, under
 * its own checks.
 */
export async function settleNativeTokenLease(kind: NativeTokenLeaseKind, db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_a_process" };
  const stamp = record.owner.stamp;
  const { now } = context;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [row] = await tx.select({
      runId: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
      issueId: nativeRunFinalizations.issueId, decisionId: nativeRunFinalizations.decisionId,
      agentId: heartbeatRuns.agentId, leaseOwner: nativeRunFinalizations.leaseOwner,
      leaseHolder: nativeRunFinalizations.leaseHolder,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
      .where(and(eq(nativeRunFinalizations.runId, record.recordId), like(nativeRunFinalizations.leaseOwner, `${PREFIX[kind]}%`),
        gt(nativeRunFinalizations.leaseExpiresAt, now)))
      .for("update", { of: nativeRunFinalizations });
    if (!row?.leaseOwner) return { settled: false, reason: "lease_no_longer_held" };
    const holder = readNativeLeaseHolder(row.leaseHolder, row.leaseOwner);
    // The proof judged this exact process; the lease has moved on since.
    if (!holder || holder.bootId !== stamp.bootId || holder.pid !== stamp.pid || holder.hostHash !== stamp.processSpace
      || holder.processStartedAt !== (stamp.processStartedAt ?? null)) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    // Work intents before the write they announce (sleep-aware background work).
    if (kind === "native_finalizer_lease") {
      if (row.decisionId) await notifyNativeFinalizationWork(tx, { companyId: row.companyId, runId: row.runId });
      else await notifyNativeResultCommit(tx, { companyId: row.companyId, runId: row.runId, issueId: row.issueId });
    } else {
      await notifyRetainedNativeSessionCleanup(tx, { companyId: row.companyId, runId: row.runId,
        issueId: row.issueId, agentId: row.agentId });
    }
    const updated = await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: now, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, row.runId), eq(nativeRunFinalizations.leaseOwner, row.leaseOwner),
        gt(nativeRunFinalizations.leaseExpiresAt, now),
        sql`${nativeRunFinalizations.leaseHolder}->>'token' = ${row.leaseOwner}`))
      .returning({ runId: nativeRunFinalizations.runId });
    return updated.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_no_longer_held" };
  });
}
