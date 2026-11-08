import { and, eq, isNull, sql } from "drizzle-orm";
import { controllerInstances, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  currentControllerBootId, currentControllerDeployment, currentProcessSpaceHash, onControllerStamp,
} from "./controller-process-identity.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { setControllerLeaseQuiesce, subscribeIdleWorkSettled } from "./task-admission.js";

export const CONTROLLER_LEASE_TTL_MS = 90_000;
export const CONTROLLER_LEASE_RENEW_MS = 30_000;
/** Renewal attempts start failing from their own start; this boot stops after this long while holding work. */
export const CONTROLLER_LEASE_SELF_FENCE_MS = 60_000;
/** A prover fences a boot only this long after the boot's last sign of life. */
export const CONTROLLER_LEASE_FENCE_GRACE_MS = 30_000;
/** A stamp counts as held work for a full lease, so a slow ownership write commits before the lease can lapse. */
const STAMP_COMMIT_GRACE_MS = CONTROLLER_LEASE_TTL_MS;
/** A settle of other work re-checks holdings at most this often. */
const SETTLE_RECHECK_MIN_MS = 5_000;
/** A renewal that has not answered within this bound counts as failed. */
const RENEW_TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;

export type ControllerInstanceState = "live" | "grace" | "expired" | "fenced" | "stopped";
/** "holding" saw an in-progress record held by this boot; "holding_stamp" held only for a recent stamp. */
type RenewResult = "holding" | "holding_stamp" | "idle" | "fenced";
/** A stamp whose record no renewal has seen keeps the lease held until the server's tracked work next settles
 * (its write then committed or rolled back), and at most this long. */
const UNOBSERVED_STAMP_CAP_MS = 10 * 60_000;

type LeaseState = {
  onLost: (reason: "fenced" | "lease_lost") => void;
  now: () => number;
  renew: (stampedRecently: boolean) => Promise<RenewResult>;
  lastStampAt: number;
  /** Start of the first renewal attempt in the current failing streak. */
  failingSince: number | null;
  /** Renewal is due: this boot stamped work, or its last renewal found work it still holds. */
  active: boolean;
  epoch: number | null;
  stopped: boolean;
  /** Wall-clock time of the last stamp (the stamp window follows the server's clock). */
  lastStampWallAt: number;
  lastTickAt: number;
  /** Counts stamps, so a stamp taken while a renewal is in flight is never lost. */
  stampSeq: number;
  /** Wall time of the oldest stamp no renewal has yet seen a held record for. */
  unobservedStampSince: number | null;
  unsubscribe: () => void;
  wake: () => void;
};

let state: LeaseState | null = null;
let registeredDb: Db | null = null;

/** A Railway deployment with an exclusive volume proves a replaced deployment on its own; every
 * other host (Docker, Kubernetes, Fly, a stateless Railway service, a rebooted machine) needs the
 * lease to prove a replaced process. PAPERCLIP_CONTROLLER_INSTANCE_LEASE=on|off overrides this. */
export function controllerInstanceLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.PAPERCLIP_CONTROLLER_INSTANCE_LEASE;
  if (setting === "off") return false;
  if (setting === "on") return true;
  return currentControllerDeployment(env)?.exclusiveVolume !== true;
}

function exitOnLostLease(reason: "fenced" | "lease_lost") {
  logger.fatal({ reason }, "controller instance lease lost while holding work; stopping so a newer server can recover it");
  process.exit(1);
}

/** In-progress records stamped with this boot id: the process-owned kinds of the ownership registry. */
function holdsStampedWorkSql(bootId: string) {
  return sql`(
    exists (select 1 from environment_leases where
      (status = 'active' and metadata->'leaseController'->>'bootId' = ${bootId})
      or (status = 'pending_cleanup' and metadata->>'pendingCleanupInFlight' = 'true'
        and metadata->'pendingCleanupController'->>'bootId' = ${bootId}))
    or exists (select 1 from sandbox_creation_operations where state = 'pending' and metadata->'creationController'->>'bootId' = ${bootId})
    or exists (select 1 from workspace_operations where status in ('running', 'pending') and metadata->'finalizeOwner'->>'bootId' = ${bootId})
    or exists (select 1 from agents where lifecycle_operation->'leaseHolder'->>'bootId' = ${bootId})
    or exists (select 1 from native_run_finalizations where lease_owner is not null
      and lease_holder->>'token' = lease_owner and lease_holder->>'bootId' = ${bootId})
    or exists (select 1 from native_run_finalizations where controller_boot_id = ${bootId}
      and phase not in ('committed', 'terminal_failure', 'applied'))
    or exists (select 1 from heartbeat_runs where status = 'running' and controller_boot_id::text = ${bootId}))`;
}

/**
 * One statement: create this boot's row on first use, and extend its lease only while the boot
 * holds work (a stamp within the TTL, or an in-progress record stamped with its boot id).
 * Returns whether it still holds work, or that a newer boot fenced it.
 */
function renewInDatabase(db: Db): (stampedRecently: boolean) => Promise<RenewResult> {
  return async stampedRecently => {
    const bootId = currentControllerBootId();
    const records = holdsStampedWorkSql(bootId);
    const holds = sql`(${stampedRecently} or ${records})`;
    const expires = sql`now() + ${`${CONTROLLER_LEASE_TTL_MS} milliseconds`}::interval`;
    const rows = await db.execute(sql`
      insert into controller_instances (boot_id, process_space, pid, lease_expires_at)
      values (${bootId}, ${currentProcessSpaceHash()}, ${process.pid}, ${expires})
      on conflict (boot_id) do update set
        lease_expires_at = case when ${holds} then ${expires} else controller_instances.lease_expires_at end,
        renewed_at = case when ${holds} then now() else controller_instances.renewed_at end
      where controller_instances.fenced_at is null and controller_instances.stopped_at is null
      returning epoch, ${holds} as holds, ${records} as records`) as unknown as Array<{ epoch: string | number; holds: boolean; records: boolean }>;
    const row = rows[0];
    if (!row) return "fenced";
    if (state) state.epoch = Number(row.epoch);
    return row.records ? "holding" : row.holds ? "holding_stamp" : "idle";
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("controller instance lease renewal timed out")), ms);
  })]).finally(() => clearTimeout(timer));
}

/**
 * Registers this boot's lease with the shared delivery coordinator. The lease is renewed only
 * while the boot holds work, so an idle boot issues no statements and its database can sleep.
 */
export function registerControllerInstanceLeaseWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  options: {
    onLost?: (reason: "fenced" | "lease_lost") => void;
    now?: () => number;
    renew?: (stampedRecently: boolean) => Promise<RenewResult>;
  } = {}) {
  registeredDb = db;
  const current: LeaseState = {
    onLost: options.onLost ?? exitOnLostLease, now: options.now ?? (() => performance.now()),
    renew: options.renew ?? renewInDatabase(db), lastStampAt: Number.NEGATIVE_INFINITY, failingSince: null,
    active: false, epoch: null, stopped: false, unsubscribe: () => {}, wake: () => {},
    lastStampWallAt: Number.NEGATIVE_INFINITY, lastTickAt: Number.NEGATIVE_INFINITY, stampSeq: 0,
    unobservedStampSince: null,
  };
  state = current;
  const worker = coordinator.register(DELIVERY_QUEUES.controllerInstanceLease, {
    retryMs: RETRY_MS,
    runDuringDrain: true,
    run: () => tickControllerInstanceLease(),
    hasPending: async () => false,
    nextRunAt: () => nextLeaseDeadline(current),
  });
  current.wake = worker.wake;
  const unsubscribeStamp = onControllerStamp(() => {
    const wasActive = current.active;
    current.lastStampAt = current.now();
    current.lastStampWallAt = Date.now();
    current.stampSeq += 1;
    current.unobservedStampSince ??= Date.now();
    current.active = true;
    // The first stamp after an idle lapse renews at once, without delaying the stamping write.
    if (!wasActive && !current.stopped) worker.wake();
  });
  // When the server's work settles, check holdings now rather than one renewal later,
  // so an idle server issues no statement after its last work.
  // The rate limit also absorbs the settle of this worker's own run.
  const unsubscribeSettle = subscribeIdleWorkSettled(() => {
    // All tracked work finished: any ownership write it made has committed or rolled back,
    // so the holdings query is authoritative from here on.
    current.unobservedStampSince = null;
    if (current.active && !current.stopped && Date.now() - current.lastTickAt >= SETTLE_RECHECK_MIN_MS) worker.wake();
  });
  current.unsubscribe = () => { unsubscribeStamp(); unsubscribeSettle(); };
  return {
    ready: worker.ready,
    stop: async () => {
      current.unsubscribe();
      await worker.stop();
    },
  };
}

function nextLeaseDeadline(current: LeaseState): number | null {
  if (current.stopped) return null;
  if (current.failingSince !== null) return Date.now() + RETRY_MS;
  return current.active ? Date.now() + CONTROLLER_LEASE_RENEW_MS : null;
}

/** Renew while holding work; quiesce on failure; stop only if the failure outlasts the self-fence window with work held. */
export async function tickControllerInstanceLease(): Promise<void> {
  const current = state;
  if (!current || current.stopped || (!current.active && current.failingSince === null)) return;
  const attemptStartedAt = current.now();
  const stampSeqAtStart = current.stampSeq;
  current.lastTickAt = Date.now();
  // Held until a renewal sees the stamped record committed (or rolled back past the cap).
  const stampedRecently = Date.now() - current.lastStampWallAt < STAMP_COMMIT_GRACE_MS
    || (current.unobservedStampSince !== null && Date.now() - current.unobservedStampSince < UNOBSERVED_STAMP_CAP_MS);
  let result: RenewResult | "failed";
  try { result = await withTimeout(current.renew(stampedRecently), RENEW_TIMEOUT_MS); } catch (error) {
    logger.warn({ err: error }, "controller instance lease renewal failed");
    result = "failed";
  }
  if (result === "holding" || result === "holding_stamp" || result === "idle") {
    current.failingSince = null;
    // Idle: the lease lapses with no further statements until the next stamp wakes it.
    // A stamp taken during this attempt was not seen by its snapshot: check again now.
    const stampedDuringAttempt = current.stampSeq !== stampSeqAtStart;
    // A held record does not show that every stamped write has committed: another stamp's
    // write may still be pending. Only the work-settled signal (or the cap) clears it.
    current.active = result !== "idle" || stampedDuringAttempt;
    if (result === "idle" && stampedDuringAttempt) current.wake();
    setControllerLeaseQuiesce(false);
    return;
  }
  // Fenced or unreachable: dispatch nothing new while the outcome is open.
  setControllerLeaseQuiesce(true);
  if (result === "fenced") { current.stopped = true; current.onLost("fenced"); return; }
  current.failingSince ??= attemptStartedAt;
  if (current.now() - current.failingSince >= CONTROLLER_LEASE_SELF_FENCE_MS && (current.active || stampedRecently)) {
    current.stopped = true;
    current.onLost("lease_lost");
  }
}

/** Graceful shutdown: this boot no longer owns anything, so its stamps are gone at once. */
export async function stopControllerInstanceLease(db: Db | null = registeredDb): Promise<void> {
  const current = state;
  if (current) { current.stopped = true; current.unsubscribe(); }
  state = null;
  if (!db || current?.epoch == null) return;
  await db.update(controllerInstances).set({ stoppedAt: sql`now()` })
    .where(eq(controllerInstances.bootId, currentControllerBootId()))
    .catch(error => logger.warn({ err: error }, "controller instance stop record failed"));
}

/**
 * The lease state of another boot, for a record it last wrote at `touchedAt`. The boot's last
 * sign of life is the later of its lease expiry and that write plus the TTL (a boot that resumed
 * after an idle lapse renews on its first stamp). Within the grace after it, the owner is still
 * treated as alive so the record stays watched; past it, the boot is fenced (only by a newer
 * epoch) and its records are gone. A boot that held work exits before this point.
 */
export async function proveControllerInstance(db: Db, bootId: string, touchedAt: Date | null,
  options: { readOnly?: boolean } = {}): Promise<ControllerInstanceState | null> {
  const [row] = await db.select({
    fenced: sql<boolean>`${controllerInstances.fencedAt} is not null`,
    stopped: sql<boolean>`${controllerInstances.stoppedAt} is not null`,
    live: sql<boolean>`${controllerInstances.leaseExpiresAt} > now()`,
    pastGrace: sql<boolean>`greatest(${controllerInstances.leaseExpiresAt},
      ${touchedAt?.toISOString() ?? null}::timestamptz + ${`${CONTROLLER_LEASE_TTL_MS} milliseconds`}::interval)
      < now() - ${`${CONTROLLER_LEASE_FENCE_GRACE_MS} milliseconds`}::interval`,
  }).from(controllerInstances).where(eq(controllerInstances.bootId, bootId));
  if (!row) return null;
  if (row.stopped) return "stopped";
  if (row.fenced) return "fenced";
  if (row.live) return "live";
  if (!touchedAt) return "expired";
  if (!row.pastGrace) return "grace";
  // A read-only pass reports; only a mutating pass fences (or creates this boot's row).
  if (options.readOnly) return "expired";
  // Only a boot that holds a lease row of its own may fence, and only an older epoch.
  const epoch = await ownEpoch();
  if (epoch === null) return "expired";
  const [fenced] = await db.update(controllerInstances).set({ fencedAt: sql`now()`, fencedByEpoch: epoch })
    .where(and(eq(controllerInstances.bootId, bootId), isNull(controllerInstances.fencedAt), isNull(controllerInstances.stoppedAt),
      sql`greatest(${controllerInstances.leaseExpiresAt}, ${touchedAt.toISOString()}::timestamptz
        + ${`${CONTROLLER_LEASE_TTL_MS} milliseconds`}::interval)
        < now() - ${`${CONTROLLER_LEASE_FENCE_GRACE_MS} milliseconds`}::interval`,
      sql`${controllerInstances.epoch} < ${epoch}`))
    .returning({ bootId: controllerInstances.bootId });
  if (fenced) return "fenced";
  const [after] = await db.select({ fenced: sql<boolean>`${controllerInstances.fencedAt} is not null` })
    .from(controllerInstances).where(eq(controllerInstances.bootId, bootId));
  return after?.fenced ? "fenced" : "expired";
}

/** This boot's epoch, creating its row on first need (one statement). Null when the lease is off or unreachable. */
async function ownEpoch(): Promise<number | null> {
  const current = state;
  if (!current || current.stopped) return null;
  if (current.epoch === null) {
    const result = await withTimeout(current.renew(false), RENEW_TIMEOUT_MS).catch(() => null);
    if (result === "fenced") return null;
  }
  return current.epoch;
}

/** Lets the owner proof read other boots' leases, whether or not this boot holds one. */
export function registerControllerInstanceDb(db: Db): void {
  registeredDb = db;
}

export function registeredControllerInstanceDb(): Db | null {
  return registeredDb;
}

export function resetControllerInstanceLeaseForTests(): void {
  state?.unsubscribe();
  state = null;
  registeredDb = null;
  setControllerLeaseQuiesce(false);
}
