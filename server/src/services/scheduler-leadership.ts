import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * River-queue-style leader election over the single-row `scheduler_leader`
 * lease table. ALL time math happens on the DATABASE clock (`now()`) —
 * client clocks never participate, so replicas with skewed clocks cannot
 * disagree about expiry. Fencing is the renewal predicate: a paused/wedged
 * process cannot re-extend a lease that already expired, because the
 * renewal UPDATE only matches `expires_at >= now()`.
 */

/** The lease table holds one row per election; the scheduler uses one. */
const LEASE_NAME = "default";

export interface SchedulerLeadershipOptions {
  db: Db;
  /** Unique per process (e.g. a UUID minted at boot). */
  leaderId: string;
  hostname: string;
  /** Lease lifetime; the leader must renew within this window. Default 15s. */
  ttlMs?: number;
  /**
   * Loop cadence for both candidates (retry) and the leader (renewal).
   * Default 5s — must stay ≤ ttl/3 so a leader gets multiple renewal
   * attempts before its lease expires.
   */
  retryMs?: number;
  /** Random 0..jitterMs added to each loop delay (de-syncs replicas). Default retryMs/5. */
  jitterMs?: number;
  /** Invoked (and awaited) when this process becomes leader. */
  onAcquired: () => void | Promise<void>;
  /** Invoked (and awaited) when this process loses or gives up leadership. */
  onLost: () => void | Promise<void>;
}

export interface SchedulerLeadership {
  /** Begin campaigning. The first pass runs immediately, so a single replica acquires at boot without waiting retryMs. */
  start(): void;
  /**
   * Graceful shutdown: halt the loop, await any in-flight pass, then — if
   * leader — resign (DELETE own row, predicated on leader_id so a stale
   * instance can never steal a lease that moved on) and await onLost.
   * Idempotent: repeated calls return the same promise.
   */
  stop(): Promise<void>;
  /**
   * Local view of leadership. May be stale between passes — fencing is the
   * DB renewal predicate, never this flag; gate side effects that must be
   * exactly-once on the database, not on isLeader().
   */
  isLeader(): boolean;
}

export function createSchedulerLeadership(opts: SchedulerLeadershipOptions): SchedulerLeadership {
  const { db, leaderId, hostname, onAcquired, onLost } = opts;
  const ttlMs = opts.ttlMs ?? 15_000;
  const retryMs = opts.retryMs ?? 5_000;
  const jitterMs = opts.jitterMs ?? Math.floor(retryMs / 5);
  const ttlSec = ttlMs / 1000;

  let leader = false;
  let started = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  /** Delete our own row only — never another leader's (lease may have moved on). */
  async function resign(): Promise<void> {
    await db.execute(sql`DELETE FROM scheduler_leader WHERE name = ${LEASE_NAME} AND leader_id = ${leaderId}`);
  }

  async function notifyLost(): Promise<void> {
    try {
      await onLost();
    } catch (err) {
      logger.error({ err, leaderId }, "scheduler leadership onLost callback failed");
    }
  }

  /**
   * Candidate pass: reap an expired lease, then try to insert ours. The
   * DELETE only removes rows already expired by the DB clock; the INSERT's
   * ON CONFLICT DO NOTHING makes the race between candidates safe — exactly
   * one row (and therefore one leader) can exist per name.
   */
  async function candidatePass(): Promise<void> {
    await db.execute(sql`DELETE FROM scheduler_leader WHERE name = ${LEASE_NAME} AND expires_at < now()`);
    const rows = (await db.execute(sql`
      INSERT INTO scheduler_leader (name, leader_id, hostname, elected_at, expires_at)
      VALUES (${LEASE_NAME}, ${leaderId}, ${hostname}, now(), now() + make_interval(secs => ${ttlSec}))
      ON CONFLICT (name) DO NOTHING
      RETURNING leader_id
    `)) as unknown as Array<{ leader_id: string }>;
    if (rows.length === 0) return; // someone else holds the lease
    leader = true;
    try {
      await onAcquired();
    } catch (err) {
      // The scheduler failed to start — holding the lease would block every
      // other replica while we do nothing with it. Resign and stay candidate.
      logger.error({ err, leaderId }, "scheduler leadership onAcquired failed; resigning");
      leader = false;
      await resign().catch((resignErr) => {
        // The lease expires on its own; another replica reaps it within ttl.
        logger.warn({ err: resignErr, leaderId }, "scheduler leadership resign after failed onAcquired failed");
      });
    }
  }

  /**
   * Leader pass: extend the lease. The predicate `expires_at >= now()` is
   * the fencing token — if we were paused (GC, SIGSTOP, network partition)
   * past expiry, the UPDATE matches zero rows even if nobody took the lease
   * yet, and we demote rather than resurrect a dead claim.
   */
  async function leaderPass(): Promise<void> {
    const rows = (await db.execute(sql`
      UPDATE scheduler_leader
      SET expires_at = now() + make_interval(secs => ${ttlSec})
      WHERE name = ${LEASE_NAME} AND leader_id = ${leaderId} AND expires_at >= now()
      RETURNING leader_id
    `)) as unknown as Array<{ leader_id: string }>;
    if (rows.length > 0) return; // renewed
    leader = false;
    logger.warn({ leaderId }, "scheduler leadership lost (lease expired or taken over)");
    await notifyLost();
    // Continue as candidate on the next pass.
  }

  async function runPass(): Promise<void> {
    try {
      if (leader) await leaderPass();
      else await candidatePass();
    } catch (err) {
      // Any DB error during a pass: conservative demotion. We cannot prove
      // the lease is still ours, so the scheduler stops and another replica
      // takes over within ttl — duplicate-leader risk is worse than a brief
      // scheduling gap.
      logger.warn({ err, leaderId }, "scheduler leadership pass failed");
      if (leader) {
        leader = false;
        await notifyLost();
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const delay = retryMs + Math.floor(Math.random() * (jitterMs + 1));
    timer = setTimeout(tick, delay);
    timer.unref(); // never keep the process alive just to campaign
  }

  // setTimeout chain (never setInterval): the next pass is only scheduled
  // after the previous one fully settles, so passes can never overlap.
  function tick(): void {
    timer = null;
    inFlight = runPass().finally(() => {
      inFlight = null;
      scheduleNext();
    });
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    tick(); // first pass immediately — a lone replica acquires at boot
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight; // runPass never rejects
      if (leader) {
        leader = false;
        try {
          await resign();
        } catch (err) {
          // Lease expires on its own; failover just takes up to ttl longer.
          logger.warn({ err, leaderId }, "scheduler leadership resign on stop failed");
        }
        await notifyLost();
      }
    })();
    return stopPromise;
  }

  return { start, stop, isLeader: () => leader };
}
