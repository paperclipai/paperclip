import { notifyActiveExecutionRecovery, notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, livenessDb, type Db } from "@paperclipai/db";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import type { LegacyControllerLeaseLossCause, LegacyControllerLeaseLossTiming } from "./run-cancellation.js";
import { randomUUID } from "node:crypto";
import {
  currentControllerBootId,
  currentControllerProcessStamp,
  readControllerProcess,
} from "./controller-process-identity.js";
import { proveOwnerGone, type LocalOwnerStamp, type OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";

// A boot UUID has meaning across containers; a numeric PID does not. Legacy
// leases stamp the single process boot id shared with native claims.
export const legacyControllerBootId = currentControllerBootId();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;

type Run = typeof heartbeatRuns.$inferSelect;

/** A lease lost before adapter dispatch: no provider work began, so the
 * continuation is retryable rather than an opaque `setup_failed`. */
export const CONTROLLER_LEASE_LOST_FAILURE_CODE = "controller_lease_lost";

/** Abort reason for a lost lease, so completion can attribute the stop. */
export class LegacyControllerLeaseLostError extends Error {
  constructor(
    readonly leaseLossCause: LegacyControllerLeaseLossCause,
    readonly leaseLossTiming?: LegacyControllerLeaseLossTiming,
  ) {
    super("Legacy controller lease lost");
    this.name = "LegacyControllerLeaseLostError";
  }
}

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    legacyProcessSettlement: null,
    controllerBootId: legacyControllerBootId,
    // This process, so a hard-killed controller is proven gone on the shared
    // ownership path (no I/O: the claim is on the dispatch path).
    controllerProcess: currentControllerProcessStamp(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

async function renewLegacyControllerLeaseInTransaction(
  tx: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  await notifyActiveExecutionRecovery(tx, { companyId: run.companyId, runId: run.id });
  const [renewed] = await tx.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  return db.transaction(tx => renewLegacyControllerLeaseInTransaction(tx as unknown as Db, run, stage));
}

/** One attempt may wait at most this long; a timed-out attempt is retried
 * until the lease deadline instead of holding the renewal for the whole lease. */
export const LEGACY_CONTROLLER_RENEWAL_STATEMENT_TIMEOUT_MS = 10_000;

/** Pause before retrying a renewal that failed with an error, so a dropped
 * connection is retried without spinning against an unavailable database. */
export const LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS = 1_000;

function isStatementTimeout(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if ((cause as { code?: unknown }).code === "57014") return true;
  }
  return false;
}

/** Renew on the private liveness pool so the write cannot queue behind an
 * unrelated slow statement on a busy shared connection. */
async function renewOnLivenessPool(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage: "dispatching" | undefined,
  statementTimeoutMs: number,
): Promise<boolean> {
  return livenessDb(db).transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`);
    return renewLegacyControllerLeaseInTransaction(tx as unknown as Db, run, stage);
  });
}

export async function liveLegacyControllerExpiresAt(db: Db, run: Run): Promise<Date | null> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return null;
  const [owner] = await db.select({ expiresAt: heartbeatRuns.controllerLeaseExpiresAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return owner?.expiresAt ?? null;
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  return (await liveLegacyControllerExpiresAt(db, run)) !== null;
}

export type RevokedLegacyControllerState = Pick<Run, "executionStage" | "processPid" | "processGroupId" | "controllerBootId">;

function isRequeueablePreparation(run: Run, adapterType: string): boolean {
  const contextIssueId = run.contextSnapshot?.issueId;
  const admittedAdapter = (run.runnerProfileJson?.adapterDispatch as { adapterType?: unknown } | undefined)?.adapterType;
  return adapterType === "paperclip_runner" && (admittedAdapter == null || admittedAdapter === adapterType)
    && run.runtimeMode === "legacy" && run.status === "running" && run.finishedAt === null
    && run.executionStage === "preparing" && Boolean(run.controllerBootId) && Boolean(run.wakeupRequestId)
    && run.processPid === null && run.processGroupId === null && run.processStartedAt === null
    && run.runnerInstanceId === null && run.nativeSessionId === null && run.nativeIssueId === null
    && run.externalRunId === null && run.nativePhase === null
    && !run.resultJson?.startupCancellation
    && (contextIssueId == null || contextIssueId === run.issueId)
    && (run.scopeKind === "issue" ? Boolean(run.issueId) : run.issueId === null);
}

async function preparationBindingsMatch(db: Db, run: Run): Promise<boolean> {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId!), eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id),
  ));
  if (!wake || !["queued", "claimed"].includes(wake.status)) return false;
  if (!run.issueId) return true;
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.id, run.issueId), eq(issues.companyId, run.companyId),
    eq(issues.assigneeAgentId, run.agentId), eq(issues.executionRunId, run.id),
  ));
  return Boolean(issue);
}

export async function readLegacyPreparationHandoffReadiness(
  db: Db, input: { companyId: string; runId: string },
): Promise<boolean> {
  const [row] = await db.select({ run: heartbeatRuns, adapterType: agents.adapterType, wake: agentWakeupRequests, issue: issues }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, heartbeatRuns.companyId), eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
      eq(agentWakeupRequests.runId, heartbeatRuns.id)))
    .leftJoin(issues, and(eq(issues.id, heartbeatRuns.issueId), eq(issues.companyId, heartbeatRuns.companyId),
      eq(issues.assigneeAgentId, heartbeatRuns.agentId), eq(issues.executionRunId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
      gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)));
  return Boolean(row && legacyControllerOwnerStamp(row.run)
    && isRequeueablePreparation(row.run, row.adapterType) && ["queued", "claimed"].includes(row.wake.status)
    && (!row.run.issueId || row.issue));
}

export async function requeueRevokedLegacyPreparation(
  db: Db, observed: Run, revoked: RevokedLegacyControllerState,
): Promise<boolean> {
  if (!observed.controllerBootId || !revoked.controllerBootId || revoked.controllerBootId === observed.controllerBootId
    || revoked.executionStage !== "preparing") return false;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    if (observed.issueId) await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, observed.issueId), eq(issues.companyId, observed.companyId))).for("update");
    if (observed.wakeupRequestId) await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, observed.wakeupRequestId), eq(agentWakeupRequests.companyId, observed.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, observed.id),
      eq(heartbeatRuns.companyId, observed.companyId), eq(heartbeatRuns.controllerBootId, revoked.controllerBootId))).for("update");
    if (!run || run.wakeupRequestId !== observed.wakeupRequestId || run.issueId !== observed.issueId) return false;
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    if (!agent || !isRequeueablePreparation(run, agent.adapterType) || !await preparationBindingsMatch(tx, run)) return false;
    await notifyRunDispatch(tx, { companyId: run.companyId });
    await tx.update(heartbeatRuns).set({ status: "queued", startedAt: null, controllerBootId: null,
      controllerProcess: null, controllerLeaseExpiresAt: null, executionStage: null, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    await tx.update(agentWakeupRequests).set({ status: "queued", claimedAt: null, updatedAt: new Date() })
      .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId!), eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.runId, run.id)));
    if (run.issueId) await tx.update(issues).set({ executionRunId: null, executionLockedAt: null,
      executionAgentNameKey: null, updatedAt: new Date() }).where(and(eq(issues.id, run.issueId),
        eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
    return true;
  });
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent.
 * Returns the stage and process identifiers committed with the revocation, or
 * null when another writer owns the row. They cannot advance afterwards,
 * because renewal requires the replaced boot ID. */
export async function revokeExpiredLegacyControllerWithState(
  db: Db,
  run: Run,
): Promise<RevokedLegacyControllerState | null> {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { executionStage: run.executionStage, processPid: run.processPid, processGroupId: run.processGroupId, controllerBootId: run.controllerBootId };
  }
  const controllerBootId = run.controllerBootId;
  const [revoked] = await db.transaction(async tx => {
    await notifyLiveRunRecovery(tx, { companyId: run.companyId, runId: run.id });
    return tx.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({
    executionStage: heartbeatRuns.executionStage,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
    controllerBootId: heartbeatRuns.controllerBootId,
  });
  });
  return revoked ?? null;
}

/**
 * The recorded controller process of a legacy lease (plan Phase 2), or null.
 * `controller_process` names the controller only while its boot id equals
 * `controller_boot_id`: revocation swaps in a random boot id, so a revoked
 * lease never keeps it. Rows saved by the previous release have none; their
 * lease stays a boot-id fence (expiry, revocation and the age guard).
 */
export function legacyControllerOwnerStamp(
  run: Pick<Run, "controllerBootId" | "controllerProcess">,
): LocalOwnerStamp | null {
  const controller = readControllerProcess(run.controllerProcess);
  if (!controller || !run.controllerBootId || controller.bootId !== run.controllerBootId) return null;
  return { kind: "local", scope: "legacy_controller_lease", generation: null, host: null,
    processSpace: controller.hostHash, bootId: controller.bootId, pid: controller.pid,
    processStartedAt: controller.processStartedAt, processGroupId: null };
}

/** True only when the shared prover proves the recorded legacy controller gone. */
export async function legacyControllerProvenGone(
  run: Pick<Run, "runtimeMode" | "controllerBootId" | "controllerProcess">,
): Promise<boolean> {
  if (run.runtimeMode === "native") return false;
  const stamp = legacyControllerOwnerStamp(run);
  return stamp !== null && (await proveOwnerGone(stamp)).verdict === "gone";
}

/**
 * The boot id of a run's legacy controller whose lease has not expired yet but
 * whose recorded process is proven gone, or null. A drained server terminalizes
 * its runs and exits with their leases unexpired; nothing of that controller is
 * left to unwind a Stop.
 */
export async function provenGoneLegacyControllerBootId(db: Db, companyId: string, runId: string): Promise<string | null> {
  const [run] = await db.select({ runtimeMode: heartbeatRuns.runtimeMode, controllerBootId: heartbeatRuns.controllerBootId,
    controllerProcess: heartbeatRuns.controllerProcess }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)));
  if (!run?.controllerBootId) return null;
  return await legacyControllerProvenGone(run) ? run.controllerBootId : null;
}

/**
 * Settle of the `legacy_controller_lease` ownership kind. The shared
 * reconciler calls it only after `proveOwnerGone` proved the recorded
 * controller gone. It expires exactly that controller's outstanding lease
 * (compare-and-swap on run, boot id and recorded pid) after waking live-run
 * recovery, which then revokes it and settles the run as a lost process under
 * its own checks (a live child process still keeps it running). It settles
 * ownership only.
 */
export async function settleLegacyControllerLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process" || !record.companyId) return { settled: false, reason: "owner_not_a_process" };
  const stamp = record.owner.stamp;
  if (!stamp.bootId) return { settled: false, reason: "owner_not_a_process" };
  const companyId = record.companyId;
  const bootId = stamp.bootId;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [row] = await tx.select({ agentId: heartbeatRuns.agentId, controllerProcess: heartbeatRuns.controllerProcess,
      controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, record.recordId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.controllerBootId, bootId), gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)))
      .for("update");
    if (!row) return { settled: false, reason: "lease_no_longer_held" };
    const current = legacyControllerOwnerStamp(row);
    // The proof judged this exact process; the lease has moved on since.
    if (!current || current.pid !== stamp.pid || current.processSpace !== stamp.processSpace
      || (current.processStartedAt ?? null) !== (stamp.processStartedAt ?? null)) {
      return { settled: false, reason: "owner_changed_since_proof" };
    }
    // Work intent before the write it announces (sleep-aware background work).
    await notifyLiveRunRecovery(tx, { companyId, runId: record.recordId, agentId: row.agentId });
    const updated = await tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp()` })
      .where(and(eq(heartbeatRuns.id, record.recordId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, bootId),
        gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)))
      .returning({ id: heartbeatRuns.id });
    return updated.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_no_longer_held" };
  });
}

export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  return (await revokeExpiredLegacyControllerWithState(db, run)) !== null;
}

/** Abort the adapter if the controller cannot renew. Bound each check by the
 * lease duration even when the database connection never settles. */
export function watchLegacyControllerLease(
  db: Db,
  run: Run,
  controller: AbortController,
  { renewalStatementTimeoutMs = LEGACY_CONTROLLER_RENEWAL_STATEMENT_TIMEOUT_MS } = {},
) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  let stopped = false;
  let pending = false;
  // Timing evidence for a loss: a renewal still in flight at the deadline
  // points at the database; a late deadline callback points at the event loop.
  let lastRenewedAt = Date.now();
  let renewalCount = 0;
  // A non-timeout error since the last successful renewal, so a deadline that
  // passes during the retries is attributed to the error, not to a stall.
  let renewalFailed = false;
  const renewalsInFlight = new Set<{ startedAt: number }>();
  let deadlineDueAt = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const lost = (cause: LegacyControllerLeaseLossCause, atDeadline = false) => {
    if (stopped || controller.signal.aborted) return;
    const now = Date.now();
    const oldestRenewal = Math.min(...[...renewalsInFlight].map((renewal) => renewal.startedAt));
    controller.abort(new LegacyControllerLeaseLostError(cause, {
      sinceRenewalMs: now - lastRenewedAt,
      renewalPendingMs: renewalsInFlight.size > 0 ? now - oldestRenewal : null,
      deadlineLateMs: atDeadline ? Math.max(0, now - deadlineDueAt) : null,
      renewalCount,
    }));
  };
  const deadlinePassed = () => lost(renewalFailed ? "renewal_error" : "renewal_deadline", true);
  const armDeadline = (delayMs: number) => {
    clearTimeout(deadline);
    deadlineDueAt = Date.now() + delayMs;
    deadline = setTimeout(deadlinePassed, delayMs);
    deadline.unref();
  };
  armDeadline(Math.max(0, (run.controllerLeaseExpiresAt?.getTime() ?? 0) - Date.now()));
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    const renewal = { startedAt };
    renewalsInFlight.add(renewal);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    // The successful attempt's UPDATE writes a fresh lease, so the local
    // deadline is measured from that attempt rather than the first one.
    // Failed attempts are retried until the deadline aborts the controller:
    // the UPDATE is idempotent and still requires this controller's boot ID.
    let attemptStartedAt = startedAt;
    const renew = async () => {
      for (;;) {
        attemptStartedAt = Date.now();
        try {
          return await renewOnLivenessPool(db, run, stage, renewalStatementTimeoutMs);
        } catch (error) {
          if (stopped || controller.signal.aborted) throw error;
          // A statement timeout is a stall; it stays a `renewal_deadline` loss.
          if (!isStatementTimeout(error)) {
            renewalFailed = true;
            await new Promise((resolve) => setTimeout(resolve, LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS));
            if (stopped || controller.signal.aborted) throw error;
          }
        }
      }
    };
    let renewed: boolean;
    try {
      renewed = await Promise.race([renew(), aborted]);
    } finally {
      renewalsInFlight.delete(renewal);
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost("renewal_rejected");
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    if (!stopped) {
      lastRenewedAt = Date.now();
      renewalCount += 1;
      renewalFailed = false;
      armDeadline(Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - attemptStartedAt)));
    }
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(() => lost("renewal_error")).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}
