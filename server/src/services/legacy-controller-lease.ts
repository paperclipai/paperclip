import { notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { and, eq, gt, isNull, lte, sql, type SQL } from "drizzle-orm";
import { controllerLeaseDb, heartbeatRuns, type Db } from "@paperclipai/db";
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

type RenewalTarget = Pick<Run, "id" | "companyId"> & { stage?: "dispatching" };
type RenewalOutcome = "renewed" | "rejected" | "busy";

async function renewLegacyControllerLeasesInTransaction(
  tx: Db,
  targets: RenewalTarget[],
): Promise<Map<string, RenewalOutcome>> {
  const requested = sql.join(targets.map(target => sql`(${target.id}::uuid, ${target.companyId}::uuid)`), sql`, `);
  const dispatching = targets.filter(target => target.stage === "dispatching").map(target => sql`${target.id}::uuid`);
  const stage = dispatching.length
    ? sql`case when r.id in (${sql.join(dispatching, sql`, `)}) then 'dispatching' else r.execution_stage end`
    : sql`r.execution_stage`;
  const rows = await tx.execute<{ id: string; renewed: boolean; examined: boolean }>(sql`
    with requested(id, company_id) as (values ${requested}),
    examined as (
      select r.id from ${heartbeatRuns} r join requested q on r.id = q.id and r.company_id = q.company_id
      for update of r skip locked
    ),
    renewed as (
      update ${heartbeatRuns} r set controller_lease_expires_at = clock_timestamp() + interval '60 seconds',
        execution_stage = ${stage}
      from examined e
      where r.id = e.id and r.runtime_mode = 'legacy' and r.status = 'running'
        and r.controller_boot_id = ${legacyControllerBootId}
        and r.controller_lease_expires_at > clock_timestamp()
      returning r.id
    )
    select q.id::text as id, exists (select 1 from renewed n where n.id = q.id) as renewed,
      exists (select 1 from examined e where e.id = q.id) as examined
    from requested q`);
  const outcomes = new Map<string, RenewalOutcome>();
  for (const row of rows) outcomes.set(row.id, row.renewed ? "renewed" : row.examined ? "rejected" : "busy");
  return outcomes;
}

export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const outcomes = await db.transaction(tx => renewLegacyControllerLeasesInTransaction(tx as unknown as Db,
    [{ id: run.id, companyId: run.companyId, stage }]));
  return outcomes.get(run.id) === "renewed";
}

/** One attempt may wait at most this long; a timed-out attempt is retried
 * until the lease deadline instead of holding the renewal for the whole lease. */
export const LEGACY_CONTROLLER_RENEWAL_STATEMENT_TIMEOUT_MS = 10_000;

/** Pause before retrying a renewal that failed with an error, so a dropped
 * connection is retried without spinning against an unavailable database. */
export const LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS = 1_000;

export const LEGACY_CONTROLLER_RENEWAL_BUSY_RETRY_DELAY_MS = 250;

function isStatementTimeout(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if ((cause as { code?: unknown }).code === "57014") return true;
  }
  return false;
}

type RenewalResult = { outcome: RenewalOutcome; issuedAt: number };
type RenewalRequest = {
  target: RenewalTarget;
  statementTimeoutMs: number;
  resolve(result: RenewalResult): void;
  reject(error: unknown): void;
};
type RenewalBatch = { pending: RenewalRequest[]; flushing: boolean };
const renewalBatches = new WeakMap<object, RenewalBatch>();

function renewThroughBatch(db: Db, target: RenewalTarget, statementTimeoutMs: number): Promise<RenewalResult> {
  let batch = renewalBatches.get(db);
  if (!batch) renewalBatches.set(db, batch = { pending: [], flushing: false });
  const outcome = new Promise<RenewalResult>((resolve, reject) => {
    batch.pending.push({ target, statementTimeoutMs, resolve, reject });
  });
  if (!batch.flushing) void flushRenewals(db, batch);
  return outcome;
}

async function flushRenewals(db: Db, batch: RenewalBatch) {
  batch.flushing = true;
  try {
    await Promise.resolve();
    while (batch.pending.length) {
      const requests = batch.pending.splice(0);
      const targets = new Map<string, RenewalTarget>();
      for (const { target } of requests) {
        const existing = targets.get(target.id);
        targets.set(target.id, existing ? { ...existing, stage: existing.stage ?? target.stage } : target);
      }
      try {
        const statementTimeoutMs = Math.min(...requests.map(request => request.statementTimeoutMs));
        let issuedAt = 0;
        const outcomes = await controllerLeaseDb(db).transaction(async (tx) => {
          issuedAt = Date.now();
          await tx.execute(sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`);
          return renewLegacyControllerLeasesInTransaction(tx as unknown as Db, [...targets.values()]);
        });
        for (const request of requests) {
          const sameCompany = targets.get(request.target.id)!.companyId === request.target.companyId;
          request.resolve({ outcome: sameCompany ? outcomes.get(request.target.id) ?? "rejected" : "rejected", issuedAt });
        }
      } catch (error) {
        for (const request of requests) request.reject(error);
      }
    }
  } finally {
    batch.flushing = false;
  }
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

export type RevokedLegacyControllerState = Pick<Run, "executionStage" | "processPid" | "processGroupId"> & { portablePreparationLeaseId?: string };

function legacyPreparationStage() {
  return and(eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.executionStage, "preparing"),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt));
}

export async function handoffLegacyControllerPreparation(db: Db, run: Run, preparationLease: SQL<string | null>, onHandoff: () => void) {
  return db.transaction(async tx => {
    await notifyLiveRunRecovery(tx, { companyId: run.companyId, runId: run.id });
    const [released] = await tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp()` })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
        legacyPreparationStage(), sql`${preparationLease} is not null`)).returning({ id: heartbeatRuns.id });
    if (!released) return false;
    onHandoff();
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
  reclaimPreparation?: SQL<string | null>,
): Promise<RevokedLegacyControllerState | null> {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { executionStage: run.executionStage, processPid: run.processPid, processGroupId: run.processGroupId };
  }
  const controllerBootId = run.controllerBootId;
  const [revoked] = await db.transaction(async tx => {
    await notifyLiveRunRecovery(tx, { companyId: run.companyId, runId: run.id });
    const expired = and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, controllerBootId),
      lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`));
    const state = { executionStage: heartbeatRuns.executionStage, processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId };
    if (reclaimPreparation) {
      const [reclaimed] = await tx.update(heartbeatRuns).set(legacyControllerClaim("legacy")).where(and(expired, legacyPreparationStage(),
        sql`${reclaimPreparation} is not null`)).returning({ ...state, portablePreparationLeaseId: reclaimPreparation });
      if (reclaimed?.portablePreparationLeaseId) return [{ ...reclaimed, portablePreparationLeaseId: reclaimed.portablePreparationLeaseId }];
    }
    return tx.update(heartbeatRuns).set({ controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    }).where(expired).returning(state);
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

/**
 * The controller process that ran a run which is already terminal, also when
 * the orphan reaper revoked its lease: revocation swaps in a random boot id
 * but keeps the recorded process. Only for judging holds on finished runs,
 * never a live lease (legacyControllerOwnerStamp owns those).
 */
export function finishedLegacyControllerOwnerStamp(
  run: Pick<Run, "status" | "controllerBootId" | "controllerProcess">,
): LocalOwnerStamp | null {
  const current = legacyControllerOwnerStamp(run);
  if (current || run.status === "running" || run.status === "queued") return current;
  const controller = readControllerProcess(run.controllerProcess);
  return controller ? legacyControllerOwnerStamp({ controllerBootId: controller.bootId, controllerProcess: run.controllerProcess })
    : null;
}

/** The shared prover's verdict on the recorded legacy controller, or null when
 * the row names none (a native run, a revoked lease, or an older row). */
export async function proveLegacyController(
  run: Pick<Run, "runtimeMode" | "controllerBootId" | "controllerProcess">,
): Promise<OwnerProof | null> {
  if (run.runtimeMode === "native") return null;
  const stamp = legacyControllerOwnerStamp(run);
  return stamp === null ? null : proveOwnerGone(stamp);
}

/** True only when the shared prover proves the recorded legacy controller gone. */
export async function legacyControllerProvenGone(
  run: Pick<Run, "runtimeMode" | "controllerBootId" | "controllerProcess">,
): Promise<boolean> {
  return (await proveLegacyController(run))?.verdict === "gone";
}

/**
 * How long a run whose lease lapsed stays with its owner while the owner's
 * server process is proven alive. The owner settles the run itself: its local
 * deadline stops the adapter and records `controller_lease_lost`. A run still
 * running after this grace has an owner that no longer drives it, and the
 * orphan reaper recovers it.
 */
export const LEGACY_LIVE_OWNER_SETTLE_GRACE_MS = 5 * 60_000;

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
    let renewedFrom = startedAt;
    const renew = async () => {
      for (;;) {
        try {
          const { outcome, issuedAt } = await renewThroughBatch(db, { id: run.id, companyId: run.companyId, stage },
            renewalStatementTimeoutMs);
          renewedFrom = issuedAt;
          if (outcome !== "busy") return outcome === "renewed";
          await new Promise((resolve) => setTimeout(resolve, LEGACY_CONTROLLER_RENEWAL_BUSY_RETRY_DELAY_MS));
          if (stopped || controller.signal.aborted) return false;
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
      armDeadline(Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - renewedFrom)));
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
