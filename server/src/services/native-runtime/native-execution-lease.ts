import type { Db } from "@paperclipai/db";
import { livenessDb, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { REMOTE_CONTROLLER_LEASE_MS } from "./native-runner-recovery-contract.js";

export const NATIVE_SESSION_EXECUTION_LEASE_TTL_MS = 20 * 60_000;
const NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;
const RENEWAL_STATEMENT_TIMEOUT_MS = 10_000;

export async function renewNativeSessionExecutionLease(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  leaseOwner: string;
  attempt: number;
  controller?: NativeControllerIdentity;
  leaseTtlMs?: number;
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
    await tx.execute(sql`select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.runId} = ${input.runId}
        and ${nativeRunFinalizations.companyId} = ${input.companyId}
        and ${nativeRunFinalizations.issueId} = ${input.issueId} for update`);
    // The database extends from UPDATE time. Exclude connection/lock waits,
    // but conservatively include UPDATE/commit response time without assuming
    // that this server's wall clock agrees with the database's clock.
    confirmedDeadline = performance.now() + leaseTtlMs;
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
          gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
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
  onLost: () => Promise<unknown>;
};
export interface NativeExecutionLeaseRenewal { stop(): Promise<void>; }

// Preparation and execution share one renewal timer. Each caller releases its
// own reference; the final release drains any SQL already in flight.
const renewals = new WeakMap<Db, Map<string, {
  input: RenewalInput; references: number; timer: ReturnType<typeof setInterval>;
  pending: Promise<void>; busy: boolean; lost: Error | null;
  deadline: ReturnType<typeof setTimeout>; loss: Promise<unknown>;
}>>();

export function startNativeSessionExecutionLeaseRenewal(input: RenewalInput): NativeExecutionLeaseRenewal {
  let owners = renewals.get(input.db);
  if (!owners) { owners = new Map(); renewals.set(input.db, owners); }
  let state = owners.get(input.leaseOwner);
  if (state) {
    if (state.input.runId !== input.runId || state.input.companyId !== input.companyId
      || state.input.issueId !== input.issueId || state.input.attempt !== input.attempt
      || state.input.controller.bootId !== input.controller.bootId || state.input.remote !== input.remote) {
      throw new Error("native_session_renewal_binding_changed");
    }
    if (state.lost) throw state.lost;
    state.references += 1;
  } else {
    const ttlMs = input.remote ? REMOTE_CONTROLLER_LEASE_MS : NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
    const lose = (error: unknown) => {
      if (state!.lost) return;
      state!.lost = error instanceof Error ? error : new Error("native_session_lease_lost");
      clearInterval(state!.timer);
      clearTimeout(state!.deadline);
      state!.loss = Promise.resolve().then(input.onLost).catch(() => undefined);
    };
    const deadline = (delay: number) => {
      const timer = setTimeout(() => lose(new Error("native_session_lease_renewal_deadline")), Math.max(0, delay));
      timer.unref?.();
      return timer;
    };
    const renew = () => {
      if (state!.lost || state!.busy) return;
      state!.busy = true;
      state!.pending = renewNativeSessionExecutionLeaseDeadline({ ...input, leaseTtlMs: ttlMs })
        .then(confirmedDeadline => {
          // A late database response cannot restore local authority after loss
          // or recreate a timer after the final caller has stopped.
          if (state!.lost || state!.references === 0) return;
          clearTimeout(state!.deadline);
          state!.deadline = deadline(confirmedDeadline - performance.now());
        })
        .catch((error: unknown) => {
          // A cancelled statement can retry at the next tick, but does not
          // extend the ownership deadline. Never queue overlapping attempts.
          for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
            if ((cause as { code?: unknown }).code === "57014") return;
          }
          lose(error);
        }).finally(() => { state!.busy = false; });
    };
    const timer = setInterval(renew, input.remote ? REMOTE_CONTROLLER_LEASE_MS / 3 : NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
    state = { input, references: 1, timer, pending: Promise.resolve(), busy: false, lost: null,
      deadline: deadline(ttlMs), loss: Promise.resolve() };
    owners.set(input.leaseOwner, state);
  }
  const owned = state;
  let stopped = false;
  return { stop: async () => {
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
