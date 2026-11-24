import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const pokes = new Set<() => void>();

/**
 * Wake the registered run scratch sweep from a run lifecycle change (a run
 * prepared its scratch directory, or a run settled and left cleanup state
 * behind). An idle sweep has no scheduled scan, so without this wake a newly
 * orphaned directory would wait for the next server restart.
 */
export function pokeRunScratchSweep(): void {
  for (const poke of pokes) poke();
}

/**
 * Instance-wide sweep of orphaned run scratch directories. The per-run
 * executor cleanup only covers runs that reach their finally block; crashed
 * or restarted runs need this worker to reclaim their scratch (and the
 * managed AI credential homes inside).
 *
 * Scheduling follows the idle-work rule: the startup pass runs once, a
 * truncated scan reschedules a bounded continuation, and a sweep that left
 * unfinished cleanup (or live runs' directories) retries on the scheduler
 * interval. A settled sweep with nothing left to do cancels its deadline
 * entirely — no pending work means no scheduled scan — and relies on
 * run lifecycle pokes to wake it again.
 */
export function registerRunScratchSweepWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  input: {
    intervalMs: number;
    canRun: () => boolean;
    sweep: () => Promise<{ truncated: boolean; pending: number }>;
  },
) {
  const { intervalMs } = input;
  const continuationMs = Math.min(intervalMs, 30_000);
  let nextAt: number | null = Date.now();
  let pendingWork = true;
  // Bumped by every poke: a sweep that finishes after a poke arrived must
  // not idle over state the in-flight scan never saw.
  let pokeEpoch = 0;
  const settle = (truncated: boolean, pending: number, observedEpoch: number) => {
    if (truncated || pending > 0) {
      pendingWork = true;
      nextAt = Date.now() + (truncated ? continuationMs : intervalMs);
    } else if (pokeEpoch !== observedEpoch) {
      // A lifecycle change arrived while the scan was running: rescan now
      // rather than idling over the missed state.
      pendingWork = true;
      nextAt = Date.now();
    } else {
      pendingWork = false;
      nextAt = null;
    }
  };
  const registered = coordinator.register(DELIVERY_QUEUES.runScratchSweep, {
    retryMs: intervalMs,
    pausePassiveMaintenance: true,
    hasPending: async () => pendingWork,
    nextRunAt: () => nextAt,
    run: async () => {
      // Idle (no deadline) means no scheduled scan: only a due deadline or a
      // lifecycle poke (which pulls the deadline to now) starts a sweep.
      if (nextAt === null || Date.now() < nextAt) return;
      if (!input.canRun()) {
        // Advance the deadline anyway: drain, standby and shutdown are
        // bounded states, and spinning on a skipped sweep helps no one. An
        // idle sweep stays idle — no deadline is invented for it.
        if (nextAt !== null) nextAt = Date.now() + intervalMs;
        return;
      }
      const observedEpoch = pokeEpoch;
      try {
        const outcome = await input.sweep();
        settle(outcome.truncated, outcome.pending, observedEpoch);
      } catch (error) {
        // A failed sweep is an unresolved obligation: retry on the interval.
        pendingWork = true;
        nextAt = Date.now() + intervalMs;
        throw error;
      }
    },
  });
  const poke = () => {
    // A lifecycle change can create reclaimable state while the sweep idles:
    // pull the deadline to now (never postpone an earlier one) and wake.
    // Pokes during a running scan are preserved through the epoch counter.
    pokeEpoch += 1;
    nextAt = Math.min(nextAt ?? Number.POSITIVE_INFINITY, Date.now());
    pendingWork = true;
    registered.wake();
  };
  pokes.add(poke);
  return {
    ...registered,
    async stop() {
      pokes.delete(poke);
      await registered.stop();
    },
  };
}
