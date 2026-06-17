import { logger } from "../middleware/logger.js";

/**
 * Generic per-replica run-executor loop. Deliberately dumb: it knows nothing
 * about the heartbeat service or the database — callers inject `claimRuns`
 * (batch-claim queued run ids), `executeRun`, and the two claim-maintenance
 * statements (`heartbeatClaims`, `releaseClaims`). Every replica runs one of
 * these; the SKIP LOCKED claim on the injected side makes concurrent
 * executors safe.
 *
 * Loop discipline copies scheduler-leadership: a serialized setTimeout chain
 * (never setInterval) with jitter, so passes can never overlap and replicas
 * de-sync naturally.
 */
export interface RunExecutorOptions {
  replicaId: string;
  /** Upper bound on concurrently executing runs on this replica. Default 5. */
  maxConcurrentRuns?: number;
  /** Claim-loop cadence; each pass adds random 0..interval/5 jitter. Default 2s. */
  fetchIntervalMs?: number;
  /** Cadence for re-stamping executor_heartbeat_at on active claims. Default 15s. */
  heartbeatIntervalMs?: number;
  /** How long stop() waits for active runs to finish before releasing their claims. Default 20s. */
  drainTimeoutMs?: number;
  /** Batch-claim up to `limit` queued runs; returns the claimed run ids. */
  claimRuns: (limit: number) => Promise<string[]>;
  executeRun: (runId: string) => Promise<void>;
  /** Injected SQL: stamp executor_heartbeat_at for the given active claims. */
  heartbeatClaims: (runIds: string[]) => Promise<void>;
  /** Injected SQL: return still-claimed runs to the queue (drain path). */
  releaseClaims: (runIds: string[]) => Promise<void>;
}

export interface RunExecutor {
  start(): void;
  /**
   * Graceful drain: halt both loops, wait up to drainTimeoutMs for active
   * executions to finish, then release whatever is still claimed back to
   * queued so another replica picks it up promptly. Idempotent — repeated
   * calls return the same promise. Never rejects.
   */
  stop(): Promise<void>;
  activeCount(): number;
}

const DRAIN_POLL_MS = 50;

export function createRunExecutor(opts: RunExecutorOptions): RunExecutor {
  const maxConcurrentRuns = opts.maxConcurrentRuns ?? 5;
  const fetchIntervalMs = opts.fetchIntervalMs ?? 2_000;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 20_000;
  const jitterMs = Math.floor(fetchIntervalMs / 5);
  const replicaId = opts.replicaId;

  const active = new Set<string>();
  let started = false;
  let stopped = false;
  let fetchTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let fetchInFlight: Promise<void> | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  async function fetchPass(): Promise<void> {
    const free = maxConcurrentRuns - active.size;
    if (free <= 0) return;
    let runIds: string[];
    try {
      runIds = await opts.claimRuns(free);
    } catch (err) {
      // A failed claim pass is retried on the next tick; it must never kill the loop.
      logger.warn({ err, replicaId }, "run executor claim pass failed");
      return;
    }
    for (const runId of runIds) {
      if (active.has(runId)) continue; // defensive: never double-track an id
      active.add(runId);
      void opts
        .executeRun(runId)
        .catch((err) => {
          logger.error({ err, runId, replicaId }, "run executor execution failed");
        })
        .finally(() => {
          active.delete(runId);
        });
    }
  }

  async function heartbeatPass(): Promise<void> {
    if (active.size === 0) return;
    const runIds = [...active];
    try {
      await opts.heartbeatClaims(runIds);
    } catch (err) {
      // Missed beats are tolerated up to the reaper's staleness window.
      logger.warn({ err, replicaId, runIds }, "run executor claim heartbeat failed");
    }
  }

  function scheduleFetch(): void {
    if (stopped) return;
    const delay = fetchIntervalMs + Math.floor(Math.random() * (jitterMs + 1));
    fetchTimer = setTimeout(fetchTick, delay);
    fetchTimer.unref();
  }

  // setTimeout chain (never setInterval): the next pass is only scheduled
  // after the previous one fully settles, so passes can never overlap.
  function fetchTick(): void {
    fetchTimer = null;
    fetchInFlight = fetchPass()
      .catch((err) => {
        logger.error({ err, replicaId }, "run executor fetch pass crashed");
      })
      .finally(() => {
        fetchInFlight = null;
        scheduleFetch();
      });
  }

  function scheduleHeartbeat(): void {
    if (stopped) return;
    heartbeatTimer = setTimeout(heartbeatTick, heartbeatIntervalMs);
    heartbeatTimer.unref();
  }

  function heartbeatTick(): void {
    heartbeatTimer = null;
    heartbeatInFlight = heartbeatPass()
      .catch((err) => {
        logger.error({ err, replicaId }, "run executor heartbeat pass crashed");
      })
      .finally(() => {
        heartbeatInFlight = null;
        scheduleHeartbeat();
      });
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    fetchTick(); // first pass immediately — queued work is picked up at boot
    scheduleHeartbeat();
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      if (fetchTimer) {
        clearTimeout(fetchTimer);
        fetchTimer = null;
      }
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Passes never reject (they catch internally).
      if (fetchInFlight) await fetchInFlight;
      if (heartbeatInFlight) await heartbeatInFlight;

      const deadline = Date.now() + drainTimeoutMs;
      while (active.size > 0 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, Math.min(DRAIN_POLL_MS, drainTimeoutMs)));
      }

      if (active.size > 0) {
        const leftover = [...active];
        logger.warn(
          { replicaId, runIds: leftover, drainTimeoutMs },
          "run executor drain timed out; releasing claims back to queued",
        );
        try {
          await opts.releaseClaims(leftover);
        } catch (err) {
          // The reaper's executor-heartbeat staleness window recovers these.
          logger.error({ err, replicaId, runIds: leftover }, "run executor failed to release claims on stop");
        }
      }
    })();
    return stopPromise;
  }

  return { start, stop, activeCount: () => active.size };
}
