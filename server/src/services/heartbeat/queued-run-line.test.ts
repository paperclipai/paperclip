import { describe, expect, it } from "vitest";
import {
  OLDEST_DISPATCH_SHARE,
  QUEUED_RUN_AGING_MS,
  RECOVERY_DISPATCH_SHARE,
  orderQueuedRunsForDispatch,
  queuedRunDispatchLine,
  type QueuedRunDispatchFacts,
} from "./queued-run-dispatch-order.js";

const now = new Date("2026-11-13T12:00:00Z");
const reasons = [null, null, "issue_continuation_needed", "issue_recovery_action_restored", "task_retry", "issue_assigned"];

// Small deterministic PRNG so failures reproduce.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function queue(seed: number, size: number): QueuedRunDispatchFacts[] {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  return Array.from({ length: size }, (_, index) => {
    // Coarse ages so equal creation times and the aging boundary both occur.
    const createdAt = new Date(now.getTime() - Math.floor(next() * 12) * (QUEUED_RUN_AGING_MS / 4));
    return {
      id: `run-${index}`,
      createdAt,
      wakeReason: pick(reasons),
      requestedByUser: next() < 0.15,
      sourceEndedAt: next() < 0.5 ? new Date(createdAt.getTime() - Math.floor(next() * 4) * 20 * 60_000) : null,
      readinessRank: pick([0, 0, 1, 2, 3]),
      priorityRank: pick([0, 1, 2, 3, 4]),
      shareDeferred: next() < 0.1,
    };
  });
}

describe("queuedRunDispatchLine", () => {
  it("matches the dispatcher's own claim-every-run order", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const runs = queue(seed, 1 + (seed % 60));
      const input = {
        now,
        startsSinceRecovery: seed % (RECOVERY_DISPATCH_SHARE + 1),
        startsSinceOldest: seed % (OLDEST_DISPATCH_SHARE + 1),
      };
      expect(queuedRunDispatchLine(runs, input).map(run => run.id), `seed ${seed}`)
        .toEqual(orderQueuedRunsForDispatch(runs, input).map(run => run.id));
    }
  });

  it("orders a 10,000-run queue without rescanning it per step", () => {
    const runs = queue(7, 10_000);
    const input = { now, startsSinceRecovery: 0, startsSinceOldest: 0 };
    const started = performance.now();
    const line = queuedRunDispatchLine(runs, input);
    const elapsedMs = performance.now() - started;
    expect(line).toHaveLength(10_000);
    expect(new Set(line.map(run => run.id)).size).toBe(10_000);
    // The quadratic replay takes about 600 ms here; the line takes a few ms.
    expect(elapsedMs).toBeLessThan(250);
  });
});
