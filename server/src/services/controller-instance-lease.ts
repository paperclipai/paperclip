import { and, eq, isNull, sql } from "drizzle-orm";
import { controllerInstances, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  currentControllerBootId, currentControllerDeployment, currentProcessSpaceHash, onControllerStamp,
} from "./controller-process-identity.js";
import { hasRegisteredLocalWork } from "./idle-local-work.js";
import { idleWorkSnapshot, setControllerLeaseQuiesce } from "./task-admission.js";

export const CONTROLLER_LEASE_TTL_MS = 90_000;
export const CONTROLLER_LEASE_RENEW_MS = 30_000;
/** While renewal keeps failing and this boot still holds work, it stops after this long. */
export const CONTROLLER_LEASE_SELF_FENCE_MS = 60_000;
/** A prover fences a boot only this long after its lease expired. */
export const CONTROLLER_LEASE_FENCE_GRACE_MS = 30_000;
/** A stamp keeps the lease renewing for this long even with no other work signal. */
const STAMP_HOLD_MS = CONTROLLER_LEASE_TTL_MS;
const RETRY_MS = 5_000;

export type ControllerInstanceState = "live" | "expired" | "fenced" | "stopped";
type RenewResult = "renewed" | "fenced";

type LeaseState = {
  db: Db;
  epoch: number;
  timer: ReturnType<typeof setTimeout> | null;
  onLost: (reason: "fenced" | "lease_lost") => void;
  now: () => number;
  holdsWork: () => boolean;
  renew: () => Promise<RenewResult>;
  renewEveryMs: number;
  retryMs: number;
  lastStampAt: number;
  failingSince: number | null;
  ticking: boolean;
  stopped: boolean;
  unsubscribe: () => void;
};

let state: LeaseState | null = null;
let registeredDb: Db | null = null;

/** Railway proves a replaced deployment on its own; every other host (Docker, Kubernetes, Fly,
 * a rebooted machine) needs the lease to prove a replaced process. */
export function controllerInstanceLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_CONTROLLER_INSTANCE_LEASE !== "off" && currentControllerDeployment(env) === null;
}

function exitOnLostLease(reason: "fenced" | "lease_lost") {
  logger.fatal({ reason }, "controller instance lease lost while holding work; stopping so a newer server can recover it");
  process.exit(1);
}

/** Work this boot holds: a recent ownership stamp, tracked in-flight work, or a local work probe. */
function defaultHoldsWork(current: LeaseState): boolean {
  return current.now() - current.lastStampAt < STAMP_HOLD_MS || idleWorkSnapshot().active > 0 || hasRegisteredLocalWork();
}

function renewInDatabase(db: Db): () => Promise<RenewResult> {
  return async () => {
    const renewed = await db.update(controllerInstances).set({
      renewedAt: sql`now()`, leaseExpiresAt: sql`now() + ${`${CONTROLLER_LEASE_TTL_MS} milliseconds`}::interval`,
    }).where(and(eq(controllerInstances.bootId, currentControllerBootId()), isNull(controllerInstances.fencedAt),
      isNull(controllerInstances.stoppedAt))).returning({ epoch: controllerInstances.epoch });
    return renewed.length ? "renewed" : "fenced";
  };
}

/**
 * Registers this boot. The lease renews only while the boot holds work, so an idle
 * server issues no queries and its database can sleep; a lapsed lease is harmless
 * because a prover fences only for records the boot touched while its lease was valid.
 */
export async function startControllerInstanceLease(db: Db, options: {
  onLost?: (reason: "fenced" | "lease_lost") => void;
  now?: () => number;
  holdsWork?: () => boolean;
  renew?: () => Promise<RenewResult>;
  renewEveryMs?: number;
  retryMs?: number;
} = {}): Promise<{ epoch: number }> {
  registeredDb = db;
  if (state) return { epoch: state.epoch };
  const [row] = await db.insert(controllerInstances).values({
    bootId: currentControllerBootId(), processSpace: currentProcessSpaceHash(), pid: process.pid,
    leaseExpiresAt: sql`now() + ${`${CONTROLLER_LEASE_TTL_MS} milliseconds`}::interval`,
  }).returning({ epoch: controllerInstances.epoch });
  const now = options.now ?? (() => performance.now());
  const current: LeaseState = {
    db, epoch: row!.epoch, timer: null, onLost: options.onLost ?? exitOnLostLease, now,
    holdsWork: () => false, renew: options.renew ?? renewInDatabase(db),
    renewEveryMs: options.renewEveryMs ?? CONTROLLER_LEASE_RENEW_MS, retryMs: options.retryMs ?? RETRY_MS,
    lastStampAt: now(), failingSince: null, ticking: false, stopped: false, unsubscribe: () => {},
  };
  current.holdsWork = options.holdsWork ?? (() => defaultHoldsWork(current));
  state = current;
  current.unsubscribe = onControllerStamp(() => {
    const idle = current.timer === null;
    current.lastStampAt = current.now();
    // The first stamp after an idle lapse renews at once, without delaying the stamping write.
    if (idle && !current.stopped) void tickControllerInstanceLease();
  });
  schedule(current, current.renewEveryMs);
  return { epoch: current.epoch };
}

function schedule(current: LeaseState, delayMs: number) {
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => { current.timer = null; void tickControllerInstanceLease(); }, delayMs);
  current.timer.unref();
}

/** Renew while holding work; quiesce on failure; stop only if the failure outlasts the self-fence window with work held. */
export async function tickControllerInstanceLease(): Promise<void> {
  const current = state;
  if (!current || current.ticking || current.stopped) return;
  current.ticking = true;
  try {
    const holding = current.holdsWork();
    if (!holding && current.failingSince === null) {
      // Idle: let the lease lapse. The next stamp wakes renewal again.
      if (current.timer) { clearTimeout(current.timer); current.timer = null; }
      return;
    }
    let result: RenewResult | "failed";
    try { result = await current.renew(); } catch (error) {
      logger.warn({ err: error }, "controller instance lease renewal failed");
      result = "failed";
    }
    if (result === "renewed") {
      current.failingSince = null;
      setControllerLeaseQuiesce(false);
      schedule(current, current.renewEveryMs);
      return;
    }
    // Fenced or unreachable: dispatch nothing new while the outcome is open.
    setControllerLeaseQuiesce(true);
    if (result === "fenced") { current.stopped = true; current.onLost("fenced"); return; }
    current.failingSince ??= current.now();
    if (current.now() - current.failingSince >= CONTROLLER_LEASE_SELF_FENCE_MS && current.holdsWork()) {
      current.stopped = true;
      current.onLost("lease_lost");
      return;
    }
    schedule(current, current.retryMs);
  } finally {
    current.ticking = false;
  }
}

/** Graceful shutdown: this boot no longer owns anything, so its stamps are gone at once. */
export async function stopControllerInstanceLease(): Promise<void> {
  const current = state;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  current.unsubscribe();
  current.stopped = true;
  state = null;
  await current.db.update(controllerInstances).set({ stoppedAt: sql`now()` })
    .where(eq(controllerInstances.bootId, currentControllerBootId()))
    .catch(error => logger.warn({ err: error }, "controller instance stop record failed"));
}

/**
 * The lease state of another boot, for a record it last touched at `touchedAt` (its
 * write time). An expired lease past the fence grace is fenced here, but only when
 * the record was touched while that lease was still valid: a boot that resumed
 * after an idle lapse wrote it later, and is alive.
 */
export async function proveControllerInstance(db: Db, bootId: string, touchedAt: Date | null):
  Promise<ControllerInstanceState | null> {
  const [row] = await db.select({
    fenced: sql<boolean>`${controllerInstances.fencedAt} is not null`,
    stopped: sql<boolean>`${controllerInstances.stoppedAt} is not null`,
    live: sql<boolean>`${controllerInstances.leaseExpiresAt} > now()`,
    leaseExpiresAt: controllerInstances.leaseExpiresAt,
  }).from(controllerInstances).where(eq(controllerInstances.bootId, bootId));
  if (!row) return null;
  if (row.stopped) return "stopped";
  if (row.fenced) return "fenced";
  if (row.live) return "live";
  if (!touchedAt || touchedAt.getTime() > row.leaseExpiresAt.getTime()) return "expired";
  const [fenced] = await db.update(controllerInstances).set({ fencedAt: sql`now()`, fencedByEpoch: state?.epoch ?? null })
    .where(and(eq(controllerInstances.bootId, bootId), isNull(controllerInstances.fencedAt), isNull(controllerInstances.stoppedAt),
      sql`${controllerInstances.leaseExpiresAt} < now() - ${`${CONTROLLER_LEASE_FENCE_GRACE_MS} milliseconds`}::interval`,
      ...(state ? [sql`${controllerInstances.epoch} < ${state.epoch}`] : [])))
    .returning({ bootId: controllerInstances.bootId });
  if (fenced) return "fenced";
  const [after] = await db.select({ fenced: sql<boolean>`${controllerInstances.fencedAt} is not null` })
    .from(controllerInstances).where(eq(controllerInstances.bootId, bootId));
  return after?.fenced ? "fenced" : "expired";
}

/** Lets the owner proof read other boots' leases, whether or not this boot holds one. */
export function registerControllerInstanceDb(db: Db): void {
  registeredDb = db;
}

export function registeredControllerInstanceDb(): Db | null {
  return registeredDb;
}

export function resetControllerInstanceLeaseForTests(): void {
  if (state?.timer) clearTimeout(state.timer);
  state?.unsubscribe();
  state = null;
  registeredDb = null;
  setControllerLeaseQuiesce(false);
}
