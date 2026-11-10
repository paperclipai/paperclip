import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, livenessDb, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
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
function nativeExecutionLeaseUntouchedCondition(stage: "observed" | "accepted"): SQL {
  const coordinatorStage = stage === "observed"
    ? sql`${nativeRunFinalizations.phase} = 'observed' and ${nativeRunFinalizations.resultId} is null`
    : sql`${nativeRunFinalizations.phase} = 'workspace_finalizing' and ${nativeRunFinalizations.resultId} is not null`;
  return sql`(${coordinatorStage}
    and ${nativeRunFinalizations.recoveryState} is null
    and ${nativeRunFinalizations.recoveryRequestId} is null
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
    await notifyLiveRunRecovery(tx, { companyId: input.companyId, runId: input.runId });
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

// Preparation and execution share one renewal timer. Each caller releases its
// own reference; the final release drains any SQL already in flight.
const renewals = new WeakMap<Db, Map<string, {
  input: RenewalInput; references: number; timer: ReturnType<typeof setInterval>;
  pending: Promise<void>; busy: boolean; lost: Error | null;
  deadline: ReturnType<typeof setTimeout>; loss: Promise<unknown>;
  confirmedDeadline: number; adopt(confirmedDeadline: number): void;
}>>();

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
    const lose = (error: unknown) => {
      if (state!.lost) return;
      state!.lost = error instanceof Error ? error : new Error("native_session_lease_lost");
      clearInterval(state!.timer);
      clearTimeout(state!.deadline);
      state!.loss = Promise.resolve().then(state!.input.onLost).catch(() => undefined);
    };
    const deadline = (delay: number) => {
      const timer = setTimeout(() => lose(new Error("native_session_lease_renewal_deadline")), Math.max(0, delay));
      timer.unref?.();
      return timer;
    };
    const renew = () => {
      if (state!.lost || state!.busy) return;
      state!.busy = true;
      const binding = state!.input;
      state!.pending = renewNativeSessionExecutionLeaseDeadline({ ...binding, leaseTtlMs: ttlMs,
        reacquire: !binding.remote && binding.controllerGeneration !== undefined
          ? { controllerGeneration: binding.controllerGeneration } : undefined })
        .then(confirmedDeadline => {
          // A late database response cannot restore local authority after loss
          // or recreate a timer after the final caller has stopped.
          if (state!.references === 0) return;
          state!.adopt(confirmedDeadline);
        })
        .catch(async (error: unknown) => {
          if (state!.input !== binding) return;
          // A cancelled statement can retry at the next tick, but does not
          // extend the ownership deadline. Never queue overlapping attempts.
          for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
            // 40P01: taking back a lapsed lease locks the run after the
            // coordinator; a writer holding them in the other order can deadlock.
            const code = (cause as { code?: unknown }).code;
            if (code === "57014" || code === "40P01") return;
          }
          const advanced = await attemptAdvancedUnderOwner(binding).catch(() => null);
          if (advanced !== false || state!.input !== binding) return;
          lose(error);
        }).finally(() => { state!.busy = false; });
    };
    const timer = setInterval(renew, input.remote ? REMOTE_CONTROLLER_LEASE_MS / 3 : NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
    const confirmedDeadline = input.confirmedDeadline ?? performance.now() + ttlMs;
    const adopt = (confirmed: number) => {
      if (state!.lost || confirmed <= state!.confirmedDeadline) return;
      clearTimeout(state!.deadline);
      state!.confirmedDeadline = confirmed;
      state!.deadline = deadline(confirmed - performance.now());
    };
    state = { input, references: 1, timer, pending: Promise.resolve(), busy: false, lost: null,
      deadline: deadline(confirmedDeadline - performance.now()), confirmedDeadline, loss: Promise.resolve(), adopt };
    owners.set(input.leaseOwner, state);
  }
  const owned = state;
  let stopped = false;
  return { remainingMs: () => owned.lost ? 0 : Math.max(0, owned.confirmedDeadline - performance.now()), stop: async () => {
    if (!stopped) {
      stopped = true;
      if (--owned.references === 0) {
        clearInterval(owned.timer);
        clearTimeout(owned.deadline);
        owners!.delete(input.leaseOwner);
      }
    }
    await owned.pending;
    await owned.loss;
    if (owned.lost) throw owned.lost;
  } };
}
