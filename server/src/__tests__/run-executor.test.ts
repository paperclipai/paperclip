import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "../services/run-executor.ts";

/**
 * Unit tests for the generic run-executor loop. All collaborators are stubs:
 * the executor itself knows nothing about the heartbeat service or the
 * database — it claims ids, dispatches them, heartbeats the active set, and
 * drains on stop.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe("createRunExecutor", () => {
  it("claims up to max minus active across passes and refills freed slots", async () => {
    const claimLimits: number[] = [];
    const running = new Map<string, () => void>();
    let nextId = 0;

    const executor = createRunExecutor({
      replicaId: "replica-test",
      maxConcurrentRuns: 2,
      fetchIntervalMs: 10,
      drainTimeoutMs: 500,
      claimRuns: async (limit) => {
        claimLimits.push(limit);
        const ids: string[] = [];
        for (let i = 0; i < limit && nextId < 3; i += 1) {
          ids.push(`run-${nextId++}`);
        }
        return ids;
      },
      executeRun: (runId) => {
        const gate = deferred();
        running.set(runId, gate.resolve);
        return gate.promise;
      },
      heartbeatClaims: async () => {},
      releaseClaims: async () => {},
    });

    executor.start();
    await waitFor(() => running.size === 2);
    expect(executor.activeCount()).toBe(2);
    // Every claim pass so far must have respected max - active.
    expect(claimLimits[0]).toBe(2);
    expect(claimLimits.every((limit) => limit >= 1 && limit <= 2)).toBe(true);

    // While saturated, passes must not claim at all (no limit <= 0 calls either).
    const callsWhenFull = claimLimits.length;
    await new Promise((res) => setTimeout(res, 50));
    expect(claimLimits.length).toBe(callsWhenFull);

    // Finish one run: exactly one slot frees, next pass claims with limit 1.
    running.get("run-0")!();
    await waitFor(() => running.has("run-2"));
    expect(claimLimits[claimLimits.length - 1]).toBe(1);
    expect(executor.activeCount()).toBe(2);

    for (const release of running.values()) release();
    await executor.stop();
  });

  it("stop drains active runs and resolves without releasing when they finish in time", async () => {
    const released: string[][] = [];
    const gate = deferred();
    const executor = createRunExecutor({
      replicaId: "replica-test",
      maxConcurrentRuns: 1,
      fetchIntervalMs: 5,
      drainTimeoutMs: 1_000,
      claimRuns: async (limit) => (limit > 0 && executorActive() === 0 ? ["run-a"] : []),
      executeRun: () => gate.promise,
      heartbeatClaims: async () => {},
      releaseClaims: async (ids) => {
        released.push(ids);
      },
    });
    const executorActive = () => executor.activeCount();

    executor.start();
    await waitFor(() => executor.activeCount() === 1);

    const stopPromise = executor.stop();
    // Finish the run while stop() is draining.
    setTimeout(() => gate.resolve(), 30);
    await stopPromise;

    expect(executor.activeCount()).toBe(0);
    expect(released).toEqual([]);
  });

  it("stop releases still-active claims after the drain timeout", async () => {
    const released: string[][] = [];
    const never = deferred(); // intentionally never resolved
    const executor = createRunExecutor({
      replicaId: "replica-test",
      maxConcurrentRuns: 2,
      fetchIntervalMs: 5,
      drainTimeoutMs: 60,
      claimRuns: async () => (executor.activeCount() === 0 ? ["run-x", "run-y"] : []),
      executeRun: () => never.promise,
      heartbeatClaims: async () => {},
      releaseClaims: async (ids) => {
        released.push([...ids].sort());
      },
    });

    executor.start();
    await waitFor(() => executor.activeCount() === 2);
    await executor.stop();

    expect(released).toEqual([["run-x", "run-y"]]);
  });

  it("heartbeats only the currently active claims", async () => {
    const beats: string[][] = [];
    const gates = new Map<string, () => void>();
    let claimed = false;
    const executor = createRunExecutor({
      replicaId: "replica-test",
      maxConcurrentRuns: 2,
      fetchIntervalMs: 5,
      heartbeatIntervalMs: 15,
      drainTimeoutMs: 500,
      claimRuns: async () => {
        if (claimed) return [];
        claimed = true;
        return ["run-1", "run-2"];
      },
      executeRun: (runId) => {
        const gate = deferred();
        gates.set(runId, gate.resolve);
        return gate.promise;
      },
      heartbeatClaims: async (ids) => {
        beats.push([...ids].sort());
      },
      releaseClaims: async () => {},
    });

    executor.start();
    await waitFor(() => gates.size === 2);
    await waitFor(() => beats.length >= 1);
    expect(beats[beats.length - 1]).toEqual(["run-1", "run-2"]);

    gates.get("run-1")!();
    await waitFor(() => executor.activeCount() === 1);
    const beatCountAfterFinish = beats.length;
    await waitFor(() => beats.length > beatCountAfterFinish);
    expect(beats[beats.length - 1]).toEqual(["run-2"]);

    gates.get("run-2")!();
    await executor.stop();

    // No heartbeat ever covered a non-active run id.
    for (const beat of beats) {
      expect(["run-1", "run-2"]).toEqual(expect.arrayContaining(beat));
    }
    // After everything finished and stop() halted the loops there must be no
    // empty-set heartbeats (heartbeatClaims is only invoked when non-empty).
    expect(beats.every((beat) => beat.length > 0)).toBe(true);
  });

  it("stop is idempotent and returns the same settled promise", async () => {
    const releaseCalls = vi.fn(async () => {});
    const executor = createRunExecutor({
      replicaId: "replica-test",
      fetchIntervalMs: 5,
      drainTimeoutMs: 20,
      claimRuns: async () => [],
      executeRun: async () => {},
      heartbeatClaims: async () => {},
      releaseClaims: releaseCalls,
    });

    executor.start();
    const first = executor.stop();
    const second = executor.stop();
    expect(second).toBe(first);
    await first;
    await second;
    expect(releaseCalls).not.toHaveBeenCalled();
  });

  it("claim and execute errors do not kill the loop", async () => {
    let calls = 0;
    const executed: string[] = [];
    const executor = createRunExecutor({
      replicaId: "replica-test",
      maxConcurrentRuns: 2,
      fetchIntervalMs: 5,
      drainTimeoutMs: 100,
      claimRuns: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient claim failure");
        if (calls === 2) return ["run-bad"];
        if (calls === 3) return ["run-good"];
        return [];
      },
      executeRun: async (runId) => {
        executed.push(runId);
        if (runId === "run-bad") throw new Error("execution failed");
      },
      heartbeatClaims: async () => {},
      releaseClaims: async () => {},
    });

    executor.start();
    await waitFor(() => executed.includes("run-good"));
    expect(executed).toEqual(["run-bad", "run-good"]);
    expect(executor.activeCount()).toBe(0);
    await executor.stop();
  });

  it("does not claim after stop", async () => {
    let claims = 0;
    const executor = createRunExecutor({
      replicaId: "replica-test",
      fetchIntervalMs: 5,
      drainTimeoutMs: 20,
      claimRuns: async () => {
        claims += 1;
        return [];
      },
      executeRun: async () => {},
      heartbeatClaims: async () => {},
      releaseClaims: async () => {},
    });

    executor.start();
    await waitFor(() => claims >= 1);
    await executor.stop();
    const claimsAtStop = claims;
    await new Promise((res) => setTimeout(res, 40));
    expect(claims).toBe(claimsAtStop);
  });
});
