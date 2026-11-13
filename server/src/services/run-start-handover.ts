import { sql, type SQL } from "drizzle-orm";
import { controllerLeaseDb, type Db } from "@paperclipai/db";
import { notifyDatabaseWorkOnCommit } from "@paperclipai/db/work-signals";
import { logger } from "../middleware/logger.js";
import { currentControllerBootId, currentProcessSpaceHash } from "./controller-process-identity.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { subscribeTaskDrainChanges, subscribeTaskDrainExpiry } from "./task-admission.js";

/**
 * Hand-over of new run starts during a deploy overlap.
 *
 * A replacement server reports that it starts runs by setting `dispatching_at`
 * and a short `dispatch_lease_expires_at` on its own `controller_instances` row,
 * once its queued-run dispatch is running. An older server that is still
 * serving then leaves NEW run starts (queued-run claims) to it; runs it already
 * started carry on. The lease is renewed only while an older server may still
 * be serving, so a lone server writes once and the database can still sleep.
 * If the replacement stops, drains or dies, its lease is cleared or lapses and
 * the older server starts runs again within seconds: the hand-over never leaves
 * the company without a server that starts runs.
 *
 * Readers outside this module (for example a deployer) can read "a replacement
 * is starting runs" as a row with a higher epoch than the old boot where
 * `dispatching_at is not null and dispatch_lease_expires_at > now()
 *  and stopped_at is null and fenced_at is null`.
 *
 * Database use: every statement of this module (marker writes, reads, and the
 * commit-bound notifications) runs in a small transaction on the dedicated
 * one-connection controller-lease pool with a 1 s statement timeout. It never
 * touches the shared pool and never registers tracked database work, so the
 * worker coordinator has nothing of it to reconcile there. That pool is shared
 * only with legacy controller-lease renewals: a statement here waits at most one
 * legacy batch (10 s statement timeout), inside the 15 s between a renewal and
 * the lease's expiry, and delays a legacy renewal (60 s lease, renewed every
 * 10 s) by at most 1 s. At most one read, one write and one hint are in flight.
 * An unanswered read never keeps this server yielding: a dispatch that cannot
 * get an answer within a second admits, and a yield always ends when the
 * replacement's last seen lease runs out on this server's clock.
 */
export const RUN_START_HANDOVER_RENEW_MS = 5_000;
export const RUN_START_HANDOVER_TTL_MS = 20_000;
/** A replacement renews the hand-over for at most this long after it began starting runs. */
export const RUN_START_HANDOVER_MAX_MS = 30 * 60_000;
/** A yielding server checks this often whether the replacement still starts runs. */
export const RUN_START_YIELD_RECHECK_MS = 3_000;

const DEFAULT_TIMING = {
  renewMs: RUN_START_HANDOVER_RENEW_MS,
  ttlMs: RUN_START_HANDOVER_TTL_MS,
  maxMs: RUN_START_HANDOVER_MAX_MS,
  /** An older boot counts as possibly serving while its lease was live this recently. */
  olderBootWindowMs: RUN_START_HANDOVER_MAX_MS,
  recheckMs: RUN_START_YIELD_RECHECK_MS,
  /** A dispatch pass first waits for a read when the last one is older than this: the bound on a stale answer. */
  staleAwaitMs: 2_000,
  /** A dispatch waits at most this long for that read; the read itself is cancelled by the database. */
  readWaitMs: 1_000,
  readStatementTimeoutMs: 1_000,
  /** Short, so a marker write can delay a legacy lease renewal on the shared lease connection by at most this. */
  writeStatementTimeoutMs: 1_000,
  /** Skipped starts are announced to the replacement at most this often. */
  skipHintMinMs: 1_000,
  /** A clear that failed while this server cannot start runs is retried this often until the lease would lapse. */
  clearRetryMs: 1_000,
};

const interval = (ms: number) => sql`${`${ms} milliseconds`}::interval`;

export type RunStartHandover = ReturnType<typeof createRunStartHandover>;

export function createRunStartHandover(input: {
  db: Db;
  /** The server's shared worker coordinator: renewals and rechecks are its deadlines. */
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  /** This server may start runs now (not stopping, draining, or in standby). */
  canDispatch: () => boolean;
  /** Called when a yielding server starts runs again. */
  onResume?: () => void;
  bootId?: string;
  processSpace?: string;
  pid?: number;
  timing?: Partial<typeof DEFAULT_TIMING>;
}) {
  const { db } = input;
  const t = { ...DEFAULT_TIMING, ...input.timing };
  const bootId = input.bootId ?? currentControllerBootId();
  let stopped = false;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* never blocks */ } } };

  // Replacement side. Every marker write runs in this one chain, so a release
  // always lands after a renewal that was already in flight.
  let intendedAt: number | null = null;
  let released = false;
  let olderMayServe = true;
  let leaseHeld = false;
  /** A marker was written and no clear has succeeded since: a release must (re)try the clear. */
  let markerMayBeLive = false;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let lastClearAttemptAt = Number.NEGATIVE_INFINITY;
  let writes: Promise<void> = Promise.resolve();
  const handingOver = () => intendedAt !== null && !released && olderMayServe && Date.now() - intendedAt < t.maxMs;
  let reportedHandingOver = false;
  const reportHandingOver = () => {
    const now = handingOver();
    if (now !== reportedHandingOver) { reportedHandingOver = now; changed(); }
  };

  // Older-server side: the in-memory flag every run start reads.
  let yieldingTo: string | null = null;
  /** Local-clock end of the replacement's last seen lease: a yield is never kept past it, read or no read. */
  let yieldUntil = Number.NEGATIVE_INFINITY;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;
  let readRequested = false;
  let lastSkipHintAt = Number.NEGATIVE_INFINITY;
  let hinting: Promise<void> | null = null;

  /**
   * One statement under a statement timeout, so a slow database cancels it instead of holding a pool connection.
   * With `announce`, the marker-change notification is part of the same transaction on the same connection: it is
   * delivered on commit, and nothing in the write path waits on another pool.
   */
  function bounded<T>(statement: SQL, timeoutMs: number, announce = false): Promise<T[]> {
    // Every statement of this module runs here: never on the shared pool, whose stalls must not move run starts.
    return controllerLeaseDb(db).transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
      // Commit-bound and untracked: a failed write leaves no uncertain transaction for the coordinator to
      // reconcile on the shared pool before the next renewal.
      if (announce) await notifyDatabaseWorkOnCommit(tx, DELIVERY_QUEUES.runStartHandover);
      return await tx.execute(statement) as unknown as T[];
    });
  }

  const serialize = (work: () => Promise<void>) => {
    const next = writes.then(work);
    writes = next.catch(error => { logger.warn({ err: error }, "run start hand-over write failed; its lease lapses unless a later write succeeds"); });
    return writes;
  };

  async function writeLease(announce: boolean) {
    const [row] = await bounded<{ olderMayServe: boolean }>(sql`
      insert into controller_instances (boot_id, process_space, pid, lease_expires_at, dispatching_at, dispatch_lease_expires_at)
      values (${bootId}, ${input.processSpace ?? currentProcessSpaceHash()}, ${input.pid ?? process.pid}, now(), now(),
        now() + ${interval(t.ttlMs)})
      on conflict (boot_id) do update set
        dispatching_at = coalesce(controller_instances.dispatching_at, now()),
        dispatch_lease_expires_at = now() + ${interval(t.ttlMs)}
      where controller_instances.fenced_at is null and controller_instances.stopped_at is null
      returning exists (select 1 from controller_instances older
        where older.epoch < controller_instances.epoch and older.boot_id <> ${bootId}
          and older.stopped_at is null and older.fenced_at is null
          and older.lease_expires_at > now() - ${interval(t.olderBootWindowMs)}) as "olderMayServe"`, t.writeStatementTimeoutMs,
      announce);
    return row ?? null;
  }

  async function clearLease() {
    await bounded(sql`update controller_instances set dispatch_lease_expires_at = null
      where boot_id = ${bootId} and dispatch_lease_expires_at is not null`, t.writeStatementTimeoutMs, true);
    // Only a clear that succeeded ends the marker; a failed one is retried by the next release or renewal.
    leaseHeld = false;
    markerMayBeLive = false;
  }

  /** Set, renew, or clear the marker to match whether this server can start runs now. */
  function maintainLease(): Promise<void> {
    return serialize(async () => {
      if (intendedAt === null || released || !handingOver() && leaseHeld) return;
      if (!input.canDispatch()) {
        // Draining, standby or admission closed: the older server takes run starts back now.
        if (markerMayBeLive) {
          lastClearAttemptAt = Date.now();
          await clearLease();
        }
        return;
      }
      if (Date.now() - lastWriteAt < t.renewMs / 2) return;
      // Counted from the attempt, so a failing database is retried on the renewal cadence, not in a loop.
      lastWriteAt = Date.now();
      markerMayBeLive = true;
      let row: Awaited<ReturnType<typeof writeLease>>;
      // A first or regained marker tells the older server in the same transaction.
      try { row = await writeLease(!leaseHeld); }
      catch (error) {
        // Unconfirmed: the next successful write counts as regained and tells the older server again.
        leaseHeld = false;
        throw error;
      }
      const regained = row !== null && !leaseHeld;
      leaseHeld = row !== null;
      // No older server left to hand over from: the lease lapses without further writes.
      olderMayServe = row?.olderMayServe ?? false;
      if (regained) {
        if (olderMayServe) logger.info("this server now starts runs; an older server still serving leaves new run starts to it");
      }
    }).finally(reportHandingOver);
  }

  /** Read whether a newer boot starts runs now. A failed or cancelled read resumes run starts here. */
  async function read(): Promise<void> {
    let next: string | null = null;
    let until = Number.NEGATIVE_INFINITY;
    const askedAt = Date.now();
    try {
      const [row] = await bounded<{ bootId: string; remainingMs: number }>(sql`
        select newer.boot_id as "bootId",
          extract(epoch from newer.dispatch_lease_expires_at - now()) * 1000 as "remainingMs"
        from controller_instances me
        join controller_instances newer on newer.epoch > me.epoch and newer.boot_id <> me.boot_id
        where me.boot_id = ${bootId} and newer.dispatching_at is not null
          and newer.dispatch_lease_expires_at > now()
          and newer.stopped_at is null and newer.fenced_at is null
        order by newer.epoch desc limit 1`, t.readStatementTimeoutMs);
      next = row?.bootId ?? null;
      // Counted from when the read was asked, so time spent waiting for the answer only shortens the yield.
      if (row) until = askedAt + Number(row.remainingMs);
    } catch (error) {
      logger.warn({ err: error }, "run start hand-over read failed; this server keeps starting runs");
    }
    lastReadAt = Date.now();
    if (stopped) return;
    const previous = yieldingTo;
    yieldingTo = next && until > Date.now() ? next : null;
    yieldUntil = until;
    next = yieldingTo;
    if (next && !previous) {
      logger.info({ replacementBootId: next }, "a newer server is starting runs; this server leaves new run starts to it");
      skipHint(true);
      changed();
      worker.wake();
    } else if (!next && previous) {
      logger.info({ replacementBootId: previous }, "the newer server stopped starting runs; this server starts runs again");
      changed();
      input.onResume?.();
    }
    // Schedule the next recheck from this answer.
    if (yieldingTo) worker.wake();
  }

  /** The replacement's lease ran out on this server's clock: start runs again even if no read has answered. */
  function expireYield() {
    if (!yieldingTo || Date.now() < yieldUntil) return;
    logger.warn({ replacementBootId: yieldingTo }, "the newer server's run start lease ran out; this server starts runs again");
    yieldingTo = null;
    changed();
    queueMicrotask(() => input.onResume?.());
  }

  /** Single flight: a slow read stays tracked until it settles, so reads never pile up on the pool. */
  function refresh(): Promise<void> {
    reading ??= read().finally(() => { reading = null; });
    return reading;
  }

  /** Runs this server skips stay queued; wake the replacement's dispatch so they do not wait for a sweep. */
  function skipHint(force = false) {
    const now = Date.now();
    // Best effort and single flight: a busy pool delays one hint, never a queue of them (the replacement's own
    // queued-run redrive still covers a lost hint).
    if (hinting || (!force && now - lastSkipHintAt < t.skipHintMinMs)) return;
    lastSkipHintAt = now;
    hinting = controllerLeaseDb(db).transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(t.writeStatementTimeoutMs)}, true)`);
      await notifyDatabaseWorkOnCommit(tx, DELIVERY_QUEUES.queuedRunDispatch);
    })
      .catch(error => logger.warn({ err: error }, "queued run dispatch hint for the newer server failed"))
      .finally(() => { hinting = null; });
  }

  function nextDeadline(): number | null {
    const deadlines: number[] = [];
    // A clear that has not succeeded yet, while this server cannot start runs: retry until the lease would lapse.
    if (handingOver() && !input.canDispatch() && markerMayBeLive && Date.now() < lastWriteAt + t.ttlMs) {
      deadlines.push(lastClearAttemptAt + t.clearRetryMs);
    }
    // Renew while handing over and able to start runs; a drain change wakes the worker otherwise.
    if (handingOver() && input.canDispatch()) deadlines.push(lastWriteAt + t.renewMs);
    if (yieldingTo) deadlines.push(reading ? yieldUntil : Math.min(lastReadAt + t.recheckMs, yieldUntil));
    return deadlines.length ? Math.max(Date.now(), Math.min(...deadlines)) : null;
  }

  const worker = input.coordinator.register(DELIVERY_QUEUES.runStartHandover, {
    retryMs: t.renewMs,
    // Clearing the marker while this server drains is what lets the older one resume.
    runDuringDrain: true,
    // Another server's marker changed.
    onSettled: () => { readRequested = true; },
    run: async () => {
      if (stopped) return;
      expireYield();
      if (handingOver()) await maintainLease();
      if (readRequested || (yieldingTo && !reading && Date.now() - lastReadAt >= t.recheckMs)) {
        readRequested = false;
        // Not awaited: a read stuck behind the pool must not hold the worker, whose lease-expiry deadline still fires.
        void refresh();
      }
    },
    hasPending: async () => false,
    nextRunAt: nextDeadline,
  });
  const stopDrainChanges = subscribeTaskDrainChanges(worker.wake);
  const stopDrainExpiry = subscribeTaskDrainExpiry(worker.wake);

  return {
    ready: worker.ready,
    /** Replacement side: this boot starts runs now. Older boots leave new starts to it. A drain defers it. */
    async begin(): Promise<void> {
      if (stopped || released || intendedAt !== null) return;
      intendedAt = Date.now();
      await maintainLease();
      worker.wake();
    },
    /** Replacement side, final (shutdown): stop claiming run starts. Older boots resume at once. */
    async release(): Promise<void> {
      released = true;
      reportHandingOver();
      // Runs after any write already in flight, so nothing restores the marker afterwards.
      await serialize(async () => { if (markerMayBeLive) await clearLease(); });
    },
    /** The hot-path flag: a newer server starts runs, so this one starts none. Never queries inline. */
    isYielding(): boolean {
      expireYield();
      if (yieldingTo) skipHint();
      return yieldingTo !== null;
    },
    /** Before a dispatch pass: when the last read is older than staleAwaitMs, wait (briefly) for a fresh one. */
    refreshIfStale(): Promise<void> | null {
      if (stopped || Date.now() - lastReadAt < t.staleAwaitMs) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = refresh();
      // The read keeps running (and stays the single flight) if this caller stops waiting. Until it
      // answers, an unconfirmed yield is not trusted: this server admits rather than risk a pause.
      const waited = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          if (reading === read && yieldingTo) {
            logger.warn({ replacementBootId: yieldingTo }, "run start hand-over read is slow; this server starts runs until it answers");
            yieldingTo = null;
            changed();
          }
          resolve();
        }, t.readWaitMs);
      });
      return Promise.race([read, waited]).finally(() => clearTimeout(timer));
    },
    refresh,
    /** This server holds a hand-over an older server may be reading. */
    isHandingOver: () => handingOver(),
    /** A hand-over involves this server (either side). Pure read, no refresh. */
    isActive: () => handingOver() || yieldingTo !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async stop(): Promise<void> {
      await this.release();
      stopped = true;
      stopDrainChanges();
      stopDrainExpiry();
      yieldingTo = null;
      await worker.stop();
      // A pending read or best-effort hint is not awaited: on the shared pool it could wait behind slow work,
      // and it settles (or fails) when the pool answers or closes. Neither can change the marker.
    },
  };
}

// The process's hand-over, when this deployment can hand over (cloud overlap).
let current: RunStartHandover | null = null;
const processListeners = new Set<() => void>();
let unsubscribeCurrent: () => void = () => {};

export function registerRunStartHandover(handover: RunStartHandover | null): void {
  unsubscribeCurrent();
  current = handover;
  unsubscribeCurrent = handover?.subscribe(() => { for (const listener of processListeners) listener(); }) ?? (() => {});
}

/** True while a newer server starts this server's new runs. No query on this path. */
export function isYieldingRunStarts(): boolean {
  return current?.isYielding() ?? false;
}

/** Null (nothing to await) unless this server has not read the hand-over recently. */
export function refreshRunStartYieldIfStale(): Promise<void> | null {
  return current?.refreshIfStale() ?? null;
}

/** Either side of a hand-over is in progress here; a pure read for listeners. */
export function isRunStartHandoverActive(): boolean {
  return current?.isActive() ?? false;
}

export function subscribeRunStartHandoverChanges(listener: () => void): () => void {
  processListeners.add(listener);
  return () => { processListeners.delete(listener); };
}
