import type { Db } from "@paperclipai/db";
import { environmentLeases, heartbeatRuns, livenessDb, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, isNotNull, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { OPERATOR_ATTESTED_CONTROLLER_HOST } from "./native-controller-host-recovery.js";
import { NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "./native-runner-ownership.js";
import { REMOTE_CONTROLLER_LEASE_MS } from "./native-runner-recovery-contract.js";

export const NATIVE_SESSION_EXECUTION_LEASE_TTL_MS = 20 * 60_000;
const NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;
const RENEWAL_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Takeover of a native execution lease is explicit, not inferred from expiry.
 *
 * A lease can lapse with its owner alive: a host sleep jumps the wall clock
 * (and the database clock) past `lease_expires_at` while this process's
 * monotonic timers barely move. Expiry then means only "nobody renewed", not
 * "the owner is gone". The same owner may take its own lapsed lease back when
 * no other actor has recorded anything on the row or run since.
 *
 * Every actor that acts on a lapsed executor lease while the run is still
 * running first writes one of the fields checked here, under the coordinator
 * row lock: restart recovery and takeover (`recovery_state`, `lease_owner`,
 * `controller_*`), the finalizer and cleanup (`lease_owner`), failure
 * settlement (`phase`, `failure_code`, `next_attempt_at`, run status), the
 * board's controller-stopped confirmation (`controller_host_hash`), another
 * server's orphan sweep (the run's ownership-unverified error code) and startup
 * cleanup (the run's `nativeStartupCleanup` marker). Exactly one side wins:
 * either that write commits first and the owner stays fenced out, or the
 * owner's lease is live again and those actors defer to it as before.
 *
 * Pre-result only: phase `observed` without an accepted result. After a result
 * is accepted, workspace finalization may act on a lapsed lease without such a
 * write, so a lapsed post-result lease is only ever relinquished, never renewed.
 * Local runs only: a remote runner is fenced by its own controller lease.
 *
 * Callers lock with `lockNativeExecutionLeaseForReacquire` first, so the run
 * row this reads is the latest committed version and stays so until commit.
 */
const OWN_RESTART_CLAIM_STATES: ReadonlyArray<readonly [disposition: string, recoveryState: string]> = [
  ["resume_dead_runner", "resuming_session"],
  ["reattach_existing_runner", "awaiting_runner_reattach"],
  ["bootstrap_incomplete", "bootstrap_incomplete"],
];

function nativeOwnRestartClaimUnchanged(): SQL {
  const last = sql`(${nativeRunFinalizations.recoveryHistory} -> -1)`;
  const pairs = sql.join(OWN_RESTART_CLAIM_STATES.map(([disposition, state]) =>
    sql`(${last} ->> 'disposition' = ${disposition} and ${nativeRunFinalizations.recoveryState} = ${state})`), sql` or `);
  return sql`(jsonb_typeof(${nativeRunFinalizations.recoveryHistory}) = 'array'
    and (${pairs})
    and ${last} ->> 'controllerGeneration' = ${nativeRunFinalizations.controllerGeneration}::text
    and ${last} ->> 'controllerBootId' = ${nativeRunFinalizations.controllerBootId}
    and ${nativeRunFinalizations.recoveryRequestId} is not distinct from (${last} ->> 'recoveryRequestId'))`;
}

function nativeExecutionLeaseUntouchedCondition(stage: "observed" | "accepted"): SQL {
  const coordinatorStage = stage === "observed"
    ? sql`${nativeRunFinalizations.phase} = 'observed' and ${nativeRunFinalizations.resultId} is null`
    : sql`${nativeRunFinalizations.phase} = 'workspace_finalizing' and ${nativeRunFinalizations.resultId} is not null`;
  return sql`(${coordinatorStage}
    and (
      (${nativeRunFinalizations.recoveryState} is null and ${nativeRunFinalizations.recoveryRequestId} is null)
      or ${nativeOwnRestartClaimUnchanged()}
    )
    and ${nativeRunFinalizations.failureCode} is null
    and ${nativeRunFinalizations.nextAttemptAt} is null
    and ${nativeRunFinalizations.controllerHostHash} is distinct from ${OPERATOR_ATTESTED_CONTROLLER_HOST}
    and exists (select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${nativeRunFinalizations.runId}
        and ${heartbeatRuns.companyId} = ${nativeRunFinalizations.companyId}
        and ${heartbeatRuns.status} = 'running'
        and ${heartbeatRuns.errorCode} is distinct from ${NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE}
        and (${heartbeatRuns.resultJson} is null or ${heartbeatRuns.resultJson} -> 'nativeStartupCleanup' is null)))`;
}

/**
 * The executor's own lease is held: live, or (local runs only) lapsed and
 * untouched since, so the same owner takes it back in this statement. The
 * caller's WHERE must also match lease owner, attempt and controller identity;
 * `controllerGeneration` is required to take back a lapsed lease.
 */
export function nativeExecutionLeaseHeldCondition(input: {
  remote: boolean; controllerGeneration?: number; relinquishAccepted?: boolean;
}): SQL {
  const live = gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`);
  if (input.remote || input.controllerGeneration === undefined) return live;
  const untouched = input.relinquishAccepted
    ? or(nativeExecutionLeaseUntouchedCondition("observed"), nativeExecutionLeaseUntouchedCondition("accepted"))!
    : nativeExecutionLeaseUntouchedCondition("observed");
  return or(live, and(eq(nativeRunFinalizations.controllerGeneration, input.controllerGeneration), untouched))!;
}

/**
 * Lock order for `nativeExecutionLeaseHeldCondition`: the coordinator row, then,
 * only when its lease has lapsed, the run row (shared). The share lock waits for
 * any in-flight run write and holds the run until commit, so the next statement
 * reads the run's latest committed state. A live lease takes no extra lock.
 * Returns whether the lease was still live.
 */
export async function lockNativeExecutionLeaseForReacquire(tx: Pick<Db, "execute">, input: {
  runId: string; companyId: string; issueId: string;
  /**
   * Lock only a row the caller's UPDATE could match: this owner's, and with
   * `preResultOnly` one without an accepted result. A row it cannot match
   * stays unlocked, as the UPDATE alone would leave it.
   */
  leaseOwner?: string; preResultOnly?: boolean;
}): Promise<boolean> {
  const rows = await tx.execute<{ live: boolean }>(sql`select coalesce(${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp(), false) as live
    from ${nativeRunFinalizations}
    where ${nativeRunFinalizations.runId} = ${input.runId}
      and ${nativeRunFinalizations.companyId} = ${input.companyId}
      and ${nativeRunFinalizations.issueId} = ${input.issueId}
      ${input.leaseOwner === undefined ? sql`` : sql`and ${nativeRunFinalizations.leaseOwner} = ${input.leaseOwner}`}
      ${input.preResultOnly ? sql`and ${nativeRunFinalizations.resultId} is null` : sql``}
    for update`);
  const row = (rows as unknown as Array<{ live: boolean }> | undefined)?.[0];
  if (!row) return false;
  if (row.live) return true;
  await tx.execute(sql`select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.id} = ${input.runId} and ${heartbeatRuns.companyId} = ${input.companyId}
    for share`);
  return false;
}

type OwnNativeRecoveryClaimInput = {
  companyId: string; runId: string; leaseOwner: string; controller?: NativeControllerIdentity;
};

async function ownNativeRecoveryClaimCondition(tx: Db, input: OwnNativeRecoveryClaimInput) {
  const [row] = await tx.select({ controllerGeneration: nativeRunFinalizations.controllerGeneration })
    .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner)));
  if (!row) return null;
  const controller = input.controller ?? await currentNativeControllerIdentity();
  return and(
    eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.runId, input.runId),
    eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
    eq(nativeRunFinalizations.controllerBootId, controller.bootId),
    eq(nativeRunFinalizations.controllerPid, controller.pid),
    eq(nativeRunFinalizations.controllerProcessStartedAt, controller.processStartedAt),
    isNotNull(nativeRunFinalizations.recoveryState),
    nativeExecutionLeaseHeldCondition({ remote: false, controllerGeneration: row.controllerGeneration }),
    notExists(tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.runId),
      sql`${environmentLeases.provider} <> 'local'`))),
  )!;
}

export async function readOwnNativeRecoveryClaimLease(
  tx: Db, input: OwnNativeRecoveryClaimInput,
): Promise<"live" | "lapsed_own_claim" | "lost"> {
  const [row] = await tx.select({
    live: sql<boolean>`coalesce(${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp(), false)`,
  }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner)));
  if (!row) return "lost";
  if (row.live) return "live";
  const condition = await ownNativeRecoveryClaimCondition(tx, input);
  if (!condition) return "lost";
  const [held] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(condition);
  return held ? "lapsed_own_claim" : "lost";
}

export async function extendOwnNativeRecoveryClaimInTransaction(tx: Db, input: OwnNativeRecoveryClaimInput): Promise<boolean> {
  const state = await readOwnNativeRecoveryClaimLease(tx, input);
  if (state === "live") return true;
  if (state === "lost") return false;
  const condition = await ownNativeRecoveryClaimCondition(tx, input);
  if (!condition) return false;
  const [held] = await tx.update(nativeRunFinalizations)
    .set({
      leaseExpiresAt: sql`clock_timestamp() + (${NATIVE_SESSION_EXECUTION_LEASE_TTL_MS} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(condition)
    .returning({ runId: nativeRunFinalizations.runId });
  return Boolean(held);
}

/** Preparation can perform provider I/O only under its current recovery claim. */
export async function assertNativeSessionPreparationAuthority(input: {
  db: Db; companyId: string; runId: string; leaseOwner: string | undefined;
  controllerGeneration?: number; providerAttempt?: number;
}) {
  if (!input.leaseOwner) throw new Error("native_session_lease_lost");
  const controller = await currentNativeControllerIdentity();
  const [owned] = await input.db.select({ runId: nativeRunFinalizations.runId })
    .from(nativeRunFinalizations).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
    .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.status, "running"),
      eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
      eq(nativeRunFinalizations.controllerBootId, controller.bootId), eq(nativeRunFinalizations.controllerPid, controller.pid),
      eq(nativeRunFinalizations.controllerProcessStartedAt, controller.processStartedAt),
      gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
      ...(input.controllerGeneration === undefined ? [] : [eq(nativeRunFinalizations.controllerGeneration, input.controllerGeneration)]),
      ...(input.providerAttempt === undefined ? [] : [eq(nativeRunFinalizations.attempt, input.providerAttempt)]),
    )).limit(1);
  if (!owned) throw new Error("native_session_lease_lost");
}

export async function nativeRecoveryClaimRelinquished(input: {
  db: Db; companyId: string; runId: string; leaseOwner: string;
}): Promise<boolean> {
  const [row] = await input.db.select({
    status: heartbeatRuns.status, resultId: nativeRunFinalizations.resultId,
    leaseOwner: nativeRunFinalizations.leaseOwner, recoveryState: nativeRunFinalizations.recoveryState,
    leaseLive: sql<boolean>`coalesce(${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp(), false)`,
    lastDisposition: sql<string | null>`${nativeRunFinalizations.recoveryHistory} -> -1 ->> 'disposition'`,
  }).from(nativeRunFinalizations).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
    .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
      eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  if (!row || row.status !== "running" || row.resultId) return false;
  if (row.leaseOwner !== null && row.leaseOwner !== input.leaseOwner) return true;
  return row.leaseOwner === input.leaseOwner && !row.leaseLive && row.recoveryState === "awaiting_runner_reattach"
    && row.lastDisposition === "restart_suspended";
}

/**
 * The run's controller is this process and its execution lease has lapsed
 * (or was released): the executor that held it detached because of that loss,
 * not because a shutdown or hot restart handed the run on.
 */
export async function ownNativeExecutionLeaseLapsed(db: Db, input: { companyId: string; id: string }): Promise<boolean> {
  const controller = await currentNativeControllerIdentity();
  const [row] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
    .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.id),
      eq(heartbeatRuns.status, "running"), isNull(nativeRunFinalizations.resultId),
      eq(nativeRunFinalizations.controllerBootId, controller.bootId), eq(nativeRunFinalizations.controllerPid, controller.pid),
      or(isNull(nativeRunFinalizations.leaseExpiresAt), sql`${nativeRunFinalizations.leaseExpiresAt} <= clock_timestamp()`)))
    .limit(1);
  return Boolean(row);
}

export async function releaseLapsedNativeRestartClaim(input: {
  db: Db; companyId: string; runId: string; leaseOwner: string; controllerGeneration: number; providerAttempt: number;
}): Promise<boolean> {
  const released = await input.db.update(nativeRunFinalizations)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
      eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
      eq(nativeRunFinalizations.controllerGeneration, input.controllerGeneration),
      eq(nativeRunFinalizations.attempt, input.providerAttempt),
      sql`${nativeRunFinalizations.leaseExpiresAt} <= clock_timestamp()`,
      sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = ${nativeRunFinalizations.runId}
        and ${heartbeatRuns.companyId} = ${input.companyId} and ${heartbeatRuns.status} = 'running')`))
    .returning({ runId: nativeRunFinalizations.runId });
  return released.length > 0;
}

/**
 * Preparation failed after a fresh claim and before any provider turn. Release
 * only this exact claim, so ordinary failure settlement can retain the source
 * as it does for failures before the claim. Any other owner or a result keeps it.
 */
export async function releaseUnstartedNativeExecutionClaim(input: {
  db: Db; runId: string; companyId: string; issueId: string; leaseOwner: string; attempt: number;
}): Promise<boolean> {
  const released = await input.db.update(nativeRunFinalizations)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
      eq(nativeRunFinalizations.attempt, input.attempt), eq(nativeRunFinalizations.phase, "observed"),
      isNull(nativeRunFinalizations.resultId)))
    .returning({ runId: nativeRunFinalizations.runId });
  return released.length > 0;
}

export async function renewNativeSessionExecutionLease(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  leaseOwner: string;
  attempt: number;
  controller?: NativeControllerIdentity;
  leaseTtlMs?: number;
  /** Local runs only: lets this exact owner take back a lease that lapsed untouched (host sleep). */
  reacquire?: { controllerGeneration: number };
}, { statementTimeoutMs = RENEWAL_STATEMENT_TIMEOUT_MS } = {}): Promise<void> {
  await renewNativeSessionExecutionLeaseDeadline(input, { statementTimeoutMs });
}

async function renewNativeSessionExecutionLeaseDeadline(
  input: Parameters<typeof renewNativeSessionExecutionLease>[0],
  { statementTimeoutMs = RENEWAL_STATEMENT_TIMEOUT_MS } = {},
): Promise<number> {
  const controller =
    input.controller ?? (await currentNativeControllerIdentity());
  const leaseTtlMs = input.leaseTtlMs ?? NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
  if (
    !Number.isInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > NATIVE_SESSION_EXECUTION_LEASE_TTL_MS
  ) {
    throw new Error("native_session_lease_ttl_invalid");
  }
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > RENEWAL_STATEMENT_TIMEOUT_MS) {
    throw new Error("native_session_renewal_timeout_invalid");
  }
  // Use the existing private pool; application queries must not consume the
  // remote controller's short renewal window. The timeout cancels actual SQL.
  let confirmedDeadline = 0;
  const [updated] = await livenessDb(input.db).transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`);
    // Check expiry after acquiring the row lock. An UPDATE alone can evaluate
    // its predicate before waiting and revive an owner that expired in the wait.
    await lockNativeExecutionLeaseForReacquire(tx, input);
    // The database extends from UPDATE time. Exclude connection/lock waits,
    // but conservatively include UPDATE/commit response time without assuming
    // that this server's wall clock agrees with the database's clock.
    confirmedDeadline = performance.now() + leaseTtlMs;
    // No recovery signal: a renewal only moves the deadline later. Recovery
    // keeps its deadline at the earlier expiry and re-reads the row then, so a
    // lapsed lease is still found at its expiry (as for the legacy lease).
    return tx.update(nativeRunFinalizations)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + (${leaseTtlMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nativeRunFinalizations.runId, input.runId),
          eq(nativeRunFinalizations.companyId, input.companyId),
          eq(nativeRunFinalizations.issueId, input.issueId),
          eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
          eq(nativeRunFinalizations.attempt, input.attempt),
          eq(nativeRunFinalizations.controllerBootId, controller.bootId),
          eq(nativeRunFinalizations.controllerPid, controller.pid),
          eq(
            nativeRunFinalizations.controllerProcessStartedAt,
            controller.processStartedAt,
          ),
          nativeExecutionLeaseHeldCondition({ remote: !input.reacquire,
            controllerGeneration: input.reacquire?.controllerGeneration }),
        ),
      )
      .returning({ runId: nativeRunFinalizations.runId });
  });
  if (!updated) throw new Error("native_session_lease_lost");
  return confirmedDeadline;
}

type RenewalInput = {
  db: Db; runId: string; companyId: string; issueId: string;
  leaseOwner: string; attempt: number; controller: NativeControllerIdentity;
  remote?: boolean;
  /** The claimed generation. Local runs then take back a lease that lapsed untouched (host sleep). */
  controllerGeneration?: number;
  confirmedDeadline?: number;
  onLost: () => Promise<unknown>;
};
export interface NativeExecutionLeaseRenewal { stop(): Promise<void>; remainingMs(): number; }

type RenewalState = {
  input: RenewalInput; references: number;
  pending: Promise<void>; busy: boolean; lost: Error | null;
  deadline: ReturnType<typeof setTimeout>; loss: Promise<unknown>;
  confirmedDeadline: number; adopt(confirmedDeadline: number): void;
  /** `performance.now()` at which the next renewal is due, and the cadence. */
  nextRenewAt: number; intervalMs: number; ttlMs: number;
  /** Renews alone (not in a shared batch) after its own renewal failed where others succeeded. */
  solo: boolean;
  /** Settles one renewal attempt of `binding` from its batch outcome. */
  renew(outcome: BatchOutcome, binding: RenewalInput): Promise<RenewalResult>;
};
type RenewalResult = "renewed" | "failed" | "settled";

/** A cancelled statement or a deadlock says nothing about the lease; retry it. */
function retryableRenewalError(error: unknown) {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    // 40P01: taking back a lapsed lease locks the run after the coordinator;
    // a writer holding them in the other order can deadlock.
    const code = (cause as { code?: unknown }).code;
    if (code === "57014" || code === "40P01") return true;
  }
  return false;
}

// Preparation and execution share one renewal. Each caller releases its own
// reference; the final release drains any SQL already in flight.
const renewals = new WeakMap<Db, Map<string, RenewalState>>();

/**
 * Batched renewal (one shared schedule per database).
 *
 * Every lease of this process is renewed by one timer. When the first lease
 * comes due, all leases due within a quarter of their own interval are renewed
 * with it, so the leases of a process converge on one batch per interval. A
 * batch is one transaction of constant size per `RENEWAL_BATCH_MAX_ROWS` rows
 * (statement timeout, row locks, update), instead of one transaction per run.
 *
 * The batch keeps the single-run guarantees:
 * - It locks each coordinator row before it reads the expiry, as the single
 *   path does, so an owner whose lease expired while another writer held the
 *   row is never revived (the UPDATE alone could test a stale expiry).
 * - It extends only a row that this exact owner still holds: run, company,
 *   task, lease owner, attempt, controller boot id, pid and process start, and
 *   a live lease. A local lease that lapsed (host sleep) and a row that
 *   another writer has locked are not decided here: they renew alone through
 *   `renewNativeSessionExecutionLeaseDeadline`, which takes the run row lock
 *   for the lapsed case and waits for the busy row, exactly as before.
 * - The confirmed deadline is sampled after the locks and before the UPDATE.
 * - A run whose row was locked live and not extended fails with
 *   `native_session_lease_lost`, independently of the other runs.
 * Like the single path, a batch sends no recovery signal: a renewal only moves
 * a deadline later, and recovery re-reads the row at the deadline it holds.
 * A batch that is cancelled (statement timeout or deadlock) extends nothing,
 * and its runs retry after `RENEWAL_BATCH_RETRY_MS`. Any other batch failure,
 * also one thrown while the statement is built, may come from one bad row, so
 * each of its runs renews alone at once and only a bad row's own run can fail.
 * A run that fails alone while others in its batch renew keeps renewing
 * alone. During an outage every single renewal fails too; those runs return
 * to the batch at their next interval, not after a short retry.
 */
const RENEWAL_BATCH_MAX_ROWS = 200;
const RENEWAL_BATCH_RETRY_MS = 1_000;
/** A batch still running after this long no longer holds back the next one. */
const RENEWAL_BATCH_STALLED_MS = 15_000;

type BatchOutcome = { renewed: number } | { lost: true } | { alone: true } | { failed: unknown };

type BatchRow = { state: RenewalState; binding: RenewalInput };

async function renewNativeExecutionLeaseBatch(db: Db, rows: BatchRow[]): Promise<Map<RenewalState, BatchOutcome>> {
  const outcomes = new Map<RenewalState, BatchOutcome>();
  const values = (items: BatchRow[], withOwner: boolean) => sql.join(items.map(({ binding, state }) => withOwner
    ? sql`(${binding.runId}::uuid, ${binding.companyId}::uuid, ${binding.issueId}::uuid, ${binding.leaseOwner}::text, ${binding.attempt}::int,
      ${binding.controller.bootId}::text, ${binding.controller.pid}::int, ${binding.controller.processStartedAt.toISOString()}::timestamptz,
      ${state.ttlMs}::int)`
    : sql`(${binding.runId}::uuid, ${binding.companyId}::uuid, ${binding.issueId}::uuid, ${binding.leaseOwner}::text)`), sql`, `);
  await livenessDb(db).transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${RENEWAL_STATEMENT_TIMEOUT_MS}ms`}, true)`);
    // Lock first, then read the expiry from the locked row version. A row that
    // another writer holds is skipped and renews alone, so one busy run cannot
    // hold the whole batch until its statement timeout.
    const locked = await tx.execute<{ run_id: string; live: boolean }>(sql`
      with requested(run_id, company_id, issue_id, lease_owner) as (values ${values(rows, false)})
      select f.run_id::text as run_id, coalesce(f.lease_expires_at > clock_timestamp(), false) as live
      from ${nativeRunFinalizations} f
      join requested q on f.run_id = q.run_id and f.company_id = q.company_id
        and f.issue_id = q.issue_id and f.lease_owner = q.lease_owner
      order by f.run_id
      for update of f skip locked`);
    const lockedRows = new Map<string, boolean>();
    for (const row of (locked as unknown as Array<{ run_id: string; live: boolean }> | undefined) ?? []) {
      lockedRows.set(row.run_id, row.live);
    }
    const sampledAt = performance.now();
    const live: BatchRow[] = [];
    for (const row of rows) {
      const isLive = lockedRows.get(row.binding.runId);
      // Not locked: missing, another owner's, or busy. The single path decides.
      if (isLive === undefined) outcomes.set(row.state, { alone: true });
      else if (isLive) live.push(row);
      // A lapsed local lease may be taken back only under the run row lock.
      else outcomes.set(row.state, reacquires(row.binding) ? { alone: true } : { lost: true });
    }
    if (live.length === 0) return;
    const renewed = await tx.execute<{ run_id: string }>(sql`
      with requested(run_id, company_id, issue_id, lease_owner, attempt, boot_id, pid, process_started_at, ttl_ms)
        as (values ${values(live, true)})
      update ${nativeRunFinalizations} f
      set lease_expires_at = clock_timestamp() + (q.ttl_ms * interval '1 millisecond'), updated_at = clock_timestamp()
      from requested q
      where f.run_id = q.run_id and f.company_id = q.company_id and f.issue_id = q.issue_id
        and f.lease_owner = q.lease_owner and f.attempt = q.attempt
        and f.controller_boot_id = q.boot_id and f.controller_pid = q.pid
        and f.controller_process_started_at = q.process_started_at
        and f.lease_expires_at > clock_timestamp()
      returning f.run_id::text as run_id`);
    const renewedIds = new Set(((renewed as unknown as Array<{ run_id: string }> | undefined) ?? []).map(row => row.run_id));
    for (const row of live) {
      outcomes.set(row.state, renewedIds.has(row.binding.runId) ? { renewed: sampledAt + row.state.ttlMs }
        // A local lease that lapsed between the lock and the update may still
        // be taken back; only the single path can decide that.
        : reacquires(row.binding) ? { alone: true } : { lost: true });
    }
  });
  return outcomes;
}

function reacquires(binding: RenewalInput) {
  return !binding.remote && binding.controllerGeneration !== undefined;
}

type RenewalSchedule = { leases: Set<RenewalState>; timer?: ReturnType<typeof setTimeout>; flushing: number | null };
const schedules = new WeakMap<Db, RenewalSchedule>();

function renewalSchedule(db: Db): RenewalSchedule {
  let schedule = schedules.get(db);
  if (!schedule) schedules.set(db, schedule = { leases: new Set(), flushing: null });
  return schedule;
}

function scheduleRenewals(db: Db, schedule: RenewalSchedule) {
  clearTimeout(schedule.timer);
  schedule.timer = undefined;
  let at = Infinity;
  for (const state of schedule.leases) if (!state.busy && !state.lost) at = Math.min(at, state.nextRenewAt);
  if (at === Infinity) return;
  if (schedule.flushing !== null) at = Math.max(at, schedule.flushing + RENEWAL_BATCH_STALLED_MS);
  schedule.timer = setTimeout(() => runDueRenewals(db, schedule), Math.max(0, at - performance.now()));
  schedule.timer.unref?.();
}

function runDueRenewals(db: Db, schedule: RenewalSchedule) {
  schedule.timer = undefined;
  const now = performance.now();
  if (schedule.flushing !== null && now - schedule.flushing < RENEWAL_BATCH_STALLED_MS) {
    scheduleRenewals(db, schedule);
    return;
  }
  const due = [...schedule.leases].filter(state => !state.busy && !state.lost
    && state.nextRenewAt - state.intervalMs / 4 <= now);
  if (!due.some(state => state.nextRenewAt <= now)) { scheduleRenewals(db, schedule); return; }
  startRenewalBatches(db, schedule, due);
}

/**
 * Renews every lease of this process that is not renewing already, now, as one
 * batch, and resolves when each of them has settled. For tests and diagnostics;
 * the shared timer renews on its own.
 */
export async function renewNativeExecutionLeasesNow(db: Db): Promise<void> {
  const schedule = schedules.get(db);
  if (!schedule) return;
  const due = [...schedule.leases].filter(state => !state.busy && !state.lost);
  if (due.length === 0) return;
  startRenewalBatches(db, schedule, due);
  await Promise.all(due.map(state => state.pending));
}

function startRenewalBatches(db: Db, schedule: RenewalSchedule, due: RenewalState[]) {
  const now = performance.now();
  for (const state of due) { state.busy = true; state.nextRenewAt = now + state.intervalMs; }
  const flush = now;
  schedule.flushing = flush;
  const batches: Promise<unknown>[] = [];
  for (const state of due) if (state.solo) state.pending = state.renew({ alone: true }, state.input).then(() => undefined);
  const batched = due.filter(state => !state.solo);
  for (let offset = 0; offset < batched.length; offset += RENEWAL_BATCH_MAX_ROWS) {
    const rows = batched.slice(offset, offset + RENEWAL_BATCH_MAX_ROWS).map(state => ({ state, binding: state.input }));
    // An async function: an error while the statement is built rejects here too.
    const result = renewNativeExecutionLeaseBatch(db, rows).catch((error: unknown) => error);
    // Each run settles its own outcome (and any single renewal it needs);
    // stop() drains exactly that. The next batch waits only for this one.
    const settled = rows.map(row => result.then(outcomes => row.state.renew(outcomes instanceof Map
      ? outcomes.get(row.state) ?? { alone: true } : { failed: outcomes }, row.binding)));
    rows.forEach((row, index) => { row.state.pending = settled[index]!.then(() => undefined); });
    void result.then(outcomes => {
      if (outcomes instanceof Map || retryableRenewalError(outcomes)) return;
      // The batch failed but some runs renewed alone: the runs that failed
      // alone are the cause, so keep them out of later batches.
      void Promise.all(settled).then(results => {
        if (!results.includes("renewed")) return;
        results.forEach((result, index) => { if (result === "failed") rows[index]!.state.solo = true; });
      });
    });
    batches.push(result);
  }
  void Promise.all(batches).finally(() => {
    if (schedule.flushing === flush) schedule.flushing = null;
    scheduleRenewals(db, schedule);
  });
  scheduleRenewals(db, schedule);
}

async function attemptAdvancedUnderOwner(binding: RenewalInput): Promise<boolean> {
  const [row] = await livenessDb(binding.db).transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${`${RENEWAL_STATEMENT_TIMEOUT_MS}ms`}, true)`);
    return tx.select({ attempt: nativeRunFinalizations.attempt, leaseOwner: nativeRunFinalizations.leaseOwner })
      .from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId)))
      .limit(1);
  });
  return row?.leaseOwner === binding.leaseOwner && row.attempt > binding.attempt;
}

export function startNativeSessionExecutionLeaseRenewal(input: RenewalInput): NativeExecutionLeaseRenewal {
  let owners = renewals.get(input.db);
  if (!owners) { owners = new Map(); renewals.set(input.db, owners); }
  let state = owners.get(input.leaseOwner);
  if (state) {
    if (state.input.runId !== input.runId || state.input.companyId !== input.companyId
      || state.input.issueId !== input.issueId || state.input.attempt > input.attempt
      || state.input.controller.bootId !== input.controller.bootId || state.input.remote !== input.remote) {
      throw new Error("native_session_renewal_binding_changed");
    }
    if (state.lost) throw state.lost;
    if (input.attempt > state.input.attempt) {
      state.input = { ...state.input, attempt: input.attempt, onLost: input.onLost, controller: input.controller,
        controllerGeneration: input.controllerGeneration ?? state.input.controllerGeneration };
      state.adopt(input.confirmedDeadline
        ?? performance.now() + (input.remote ? REMOTE_CONTROLLER_LEASE_MS : NATIVE_SESSION_EXECUTION_LEASE_TTL_MS));
    }
    state.references += 1;
  } else {
    const ttlMs = input.remote ? REMOTE_CONTROLLER_LEASE_MS : NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
    const intervalMs = input.remote ? REMOTE_CONTROLLER_LEASE_MS / 3 : NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS;
    const schedule = renewalSchedule(input.db);
    const lose = (error: unknown) => {
      if (state!.lost) return;
      state!.lost = error instanceof Error ? error : new Error("native_session_lease_lost");
      schedule.leases.delete(state!);
      scheduleRenewals(input.db, schedule);
      clearTimeout(state!.deadline);
      state!.loss = Promise.resolve().then(state!.input.onLost).catch(() => undefined);
    };
    const deadline = (delay: number) => {
      const timer = setTimeout(() => lose(new Error("native_session_lease_renewal_deadline")), Math.max(0, delay));
      timer.unref?.();
      return timer;
    };
    const renewed = (confirmedDeadline: number) => {
      // A late database response cannot restore local authority after loss
      // or recreate a timer after the final caller has stopped.
      if (state!.references === 0) return;
      state!.adopt(confirmedDeadline);
    };
    const failed = async (error: unknown, binding: RenewalInput) => {
      if (state!.input !== binding) return;
      // A cancelled statement can retry at the next tick, but does not
      // extend the ownership deadline. Never queue overlapping attempts.
      if (retryableRenewalError(error)) return;
      const advanced = await attemptAdvancedUnderOwner(binding).catch(() => null);
      if (advanced !== false || state!.input !== binding) return;
      lose(error);
    };
    const renew = async (outcome: BatchOutcome, binding: RenewalInput): Promise<RenewalResult> => {
      let retrySoon = false, moreSql = false;
      try {
        if (state!.lost) return "settled";
        if ("renewed" in outcome) { renewed(outcome.renewed); return "renewed"; }
        if ("lost" in outcome) { moreSql = true; await failed(new Error("native_session_lease_lost"), binding); return "failed"; }
        if ("failed" in outcome && retryableRenewalError(outcome.failed)) {
          // A cancelled shared statement says nothing about any one lease:
          // extend nothing and retry soon. Each run's own deadline still
          // detaches it if renewals keep failing.
          retrySoon = true;
          state!.nextRenewAt = Math.min(state!.nextRenewAt, performance.now() + RENEWAL_BATCH_RETRY_MS);
          return "settled";
        }
        // Renew alone: the single path decides this row, and when the batch
        // failed for another reason, a bad row costs only its own run.
        moreSql = true;
        return await renewNativeSessionExecutionLeaseDeadline({ ...binding, leaseTtlMs: ttlMs,
          reacquire: reacquires(binding) ? { controllerGeneration: binding.controllerGeneration! } : undefined })
          .then((confirmed): RenewalResult => { renewed(confirmed); state!.solo = false; return "renewed"; },
            async (error: unknown): Promise<RenewalResult> => { await failed(error, binding); return "failed"; });
      } finally {
        state!.busy = false;
        // A tick that passed while this attempt was in flight is skipped, as
        // a fixed interval would skip it: a slow database gets no extra load.
        if (!retrySoon) {
          const now = performance.now();
          while (state!.nextRenewAt <= now) state!.nextRenewAt += intervalMs;
        }
        // The batch reschedules once for all of its runs that settled with
        // it; only a run that needed more SQL reschedules on its own.
        if (moreSql) scheduleRenewals(input.db, schedule);
      }
    };
    const confirmedDeadline = input.confirmedDeadline ?? performance.now() + ttlMs;
    const adopt = (confirmed: number) => {
      if (state!.lost || confirmed <= state!.confirmedDeadline) return;
      clearTimeout(state!.deadline);
      state!.confirmedDeadline = confirmed;
      state!.deadline = deadline(confirmed - performance.now());
    };
    state = { input, references: 1, pending: Promise.resolve(), busy: false, lost: null,
      deadline: deadline(confirmedDeadline - performance.now()), confirmedDeadline, loss: Promise.resolve(), adopt,
      nextRenewAt: performance.now() + intervalMs, intervalMs, ttlMs, solo: false, renew };
    owners.set(input.leaseOwner, state);
    schedule.leases.add(state);
    scheduleRenewals(input.db, schedule);
  }
  const owned = state;
  let stopped = false;
  return { remainingMs: () => owned.lost ? 0 : Math.max(0, owned.confirmedDeadline - performance.now()), stop: async () => {
    if (!stopped) {
      stopped = true;
      if (--owned.references === 0) {
        const schedule = renewalSchedule(input.db);
        schedule.leases.delete(owned);
        scheduleRenewals(input.db, schedule);
        clearTimeout(owned.deadline);
        owners!.delete(input.leaseOwner);
      }
    }
    await owned.pending;
    await owned.loss;
    if (owned.lost) throw owned.lost;
  } };
}
