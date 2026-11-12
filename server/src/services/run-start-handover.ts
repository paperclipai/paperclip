import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { publishDatabaseWorkHint, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { logger } from "../middleware/logger.js";
import { currentControllerBootId, currentProcessSpaceHash } from "./controller-process-identity.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

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
 */
export const RUN_START_HANDOVER_RENEW_MS = 5_000;
export const RUN_START_HANDOVER_TTL_MS = 20_000;
/** A replacement renews the hand-over for at most this long after it began starting runs. */
export const RUN_START_HANDOVER_MAX_MS = 30 * 60_000;
/** An older boot counts as possibly serving while its lease was live this recently. */
const OLDER_BOOT_WINDOW_MS = RUN_START_HANDOVER_MAX_MS;
/** A yielding server checks this often whether the replacement still starts runs. */
export const RUN_START_YIELD_RECHECK_MS = 3_000;

const DEFAULT_TIMING = {
  renewMs: RUN_START_HANDOVER_RENEW_MS,
  ttlMs: RUN_START_HANDOVER_TTL_MS,
  maxMs: RUN_START_HANDOVER_MAX_MS,
  olderBootWindowMs: OLDER_BOOT_WINDOW_MS,
  recheckMs: RUN_START_YIELD_RECHECK_MS,
  /** While dispatching, re-read the hand-over in the background at most this often. */
  backgroundRefreshMs: 2_000,
  /** After this long without a read (an idle stretch), the next dispatch waits for one read first. */
  staleAwaitMs: 30_000,
  readTimeoutMs: 1_000,
  /** Skipped starts are announced to the replacement at most this often. */
  skipHintMinMs: 1_000,
};

const interval = (ms: number) => sql`${`${ms} milliseconds`}::interval`;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("run start hand-over read timed out")), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

export type RunStartHandover = ReturnType<typeof createRunStartHandover>;

export function createRunStartHandover(input: {
  db: Db;
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
  // Replacement side.
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let leaseHeld = false;
  let handingOverSince: number | null = null;
  // Older-server side: the in-memory flag every run start reads.
  let yieldingTo: string | null = null;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSkipHintAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* never blocks */ } } };

  const announce = () => publishDatabaseWorkHint(db, DELIVERY_QUEUES.runStartHandover)
    .catch(error => logger.warn({ err: error }, "run start hand-over notification failed"));

  /** A not-stopped, not-fenced boot older than this one whose lease was live recently. */
  const olderBootMayServe = sql`exists (select 1 from controller_instances older
    where older.epoch < controller_instances.epoch and older.boot_id <> ${bootId}
      and older.stopped_at is null and older.fenced_at is null
      and older.lease_expires_at > now() - ${interval(t.olderBootWindowMs)})`;

  async function writeLease(): Promise<{ olderMayServe: boolean } | null> {
    const rows = await db.execute(sql`
      insert into controller_instances (boot_id, process_space, pid, lease_expires_at, dispatching_at, dispatch_lease_expires_at)
      values (${bootId}, ${input.processSpace ?? currentProcessSpaceHash()}, ${input.pid ?? process.pid}, now(), now(),
        now() + ${interval(t.ttlMs)})
      on conflict (boot_id) do update set
        dispatching_at = coalesce(controller_instances.dispatching_at, now()),
        dispatch_lease_expires_at = now() + ${interval(t.ttlMs)}
      where controller_instances.fenced_at is null and controller_instances.stopped_at is null
      returning ${olderBootMayServe} as "olderMayServe"`) as unknown as Array<{ olderMayServe: boolean }>;
    return rows[0] ?? null;
  }

  async function clearLease(): Promise<void> {
    if (!leaseHeld) return;
    leaseHeld = false;
    await db.execute(sql`update controller_instances set dispatch_lease_expires_at = null where boot_id = ${bootId}`);
    await announce();
  }

  function stopRenewing() {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
    if (handingOverSince !== null) { handingOverSince = null; changed(); }
  }

  function scheduleRenewal() {
    if (stopped || renewTimer) return;
    renewTimer = setTimeout(() => { renewTimer = null; void renew(); }, t.renewMs);
    renewTimer.unref?.();
  }

  async function renew() {
    if (stopped || handingOverSince === null) return;
    try {
      if (!input.canDispatch()) {
        // Stopping, draining or in standby: the older server takes run starts back now.
        await clearLease();
      } else {
        const row = await writeLease();
        const regained = row !== null && !leaseHeld;
        leaseHeld = row !== null;
        // Taking run starts back after a drain or standby: tell the older server now.
        if (regained) await announce();
        if (!row || !row.olderMayServe || Date.now() - handingOverSince >= t.maxMs) {
          // No older server left to hand over from: let the lease lapse without further writes.
          stopRenewing();
          return;
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "run start hand-over renewal failed; the lease lapses unless a later renewal succeeds");
    }
    scheduleRenewal();
  }

  /** Read whether a newer boot starts runs now. Any failure resumes run starts here. */
  async function read(): Promise<void> {
    let next: string | null = null;
    try {
      const rows = await withTimeout(db.execute(sql`
        select newer.boot_id as "bootId" from controller_instances me
        join controller_instances newer on newer.epoch > me.epoch and newer.boot_id <> me.boot_id
        where me.boot_id = ${bootId} and newer.dispatching_at is not null
          and newer.dispatch_lease_expires_at > now()
          and newer.stopped_at is null and newer.fenced_at is null
        order by newer.epoch desc limit 1`) as unknown as Promise<Array<{ bootId: string }>>, t.readTimeoutMs);
      next = rows[0]?.bootId ?? null;
    } catch (error) {
      logger.warn({ err: error }, "run start hand-over read failed; this server keeps starting runs");
    }
    lastReadAt = Date.now();
    if (stopped) return;
    const previous = yieldingTo;
    yieldingTo = next;
    if (next && !previous) {
      logger.info({ replacementBootId: next }, "a newer server is starting runs; this server leaves new run starts to it");
      skipHint(true);
      changed();
    } else if (!next && previous) {
      logger.info({ replacementBootId: previous }, "the newer server stopped starting runs; this server starts runs again");
      changed();
      input.onResume?.();
    }
    if (yieldingTo) scheduleRecheck();
  }

  function refresh(): Promise<void> {
    reading ??= read().finally(() => { reading = null; });
    return reading;
  }

  function scheduleRecheck() {
    if (stopped || recheckTimer) return;
    recheckTimer = setTimeout(() => { recheckTimer = null; void refresh(); }, t.recheckMs);
    recheckTimer.unref?.();
  }

  /** Runs this server skips are queued; wake the replacement's dispatch so they do not wait for a sweep. */
  function skipHint(force = false) {
    const now = Date.now();
    if (!force && now - lastSkipHintAt < t.skipHintMinMs) return;
    lastSkipHintAt = now;
    void publishDatabaseWorkHint(db, DELIVERY_QUEUES.queuedRunDispatch)
      .catch(error => logger.warn({ err: error }, "queued run dispatch hint for the newer server failed"));
  }

  const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.runStartHandover, event => {
    if (event === "settled" && !stopped) void refresh();
  });

  return {
    /** Replacement side: this boot starts runs now. Older boots leave new starts to it. */
    async begin(): Promise<void> {
      if (stopped || handingOverSince !== null || !input.canDispatch()) return;
      const row = await writeLease();
      if (!row) return;
      leaseHeld = true;
      await announce();
      if (!row.olderMayServe) return;
      logger.info("this server now starts runs; an older server still serving leaves new run starts to it");
      handingOverSince = Date.now();
      changed();
      scheduleRenewal();
    },
    /** Replacement side: stop claiming run starts (shutdown). Older boots resume at once. */
    async release(): Promise<void> {
      stopRenewing();
      await clearLease().catch(error => logger.warn({ err: error }, "run start hand-over release failed; its lease lapses"));
    },
    /** The hot-path flag: a newer server starts runs, so this one starts none. Never queries inline. */
    isYielding(): boolean {
      if (!stopped && Date.now() - lastReadAt >= t.backgroundRefreshMs) void refresh();
      if (yieldingTo) skipHint();
      return yieldingTo !== null;
    },
    /** Before a dispatch pass: after an idle stretch, read once so the first start uses a current answer. */
    refreshIfStale(): Promise<void> | null {
      if (stopped || Date.now() - lastReadAt < t.staleAwaitMs) return null;
      return refresh();
    },
    refresh,
    /** This server holds a hand-over an older server may be reading. */
    isHandingOver: () => handingOverSince !== null,
    /** A hand-over involves this server (either side). Pure read, no refresh. */
    isActive: () => handingOverSince !== null || yieldingTo !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async stop(): Promise<void> {
      await this.release();
      stopped = true;
      unsubscribe();
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = null;
      yieldingTo = null;
      await reading;
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
