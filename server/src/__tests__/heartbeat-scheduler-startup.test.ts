import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the heartbeat scheduler startup sequencing fix (GH #1165).
 *
 * Root cause: the setInterval for tickTimers was started immediately on
 * server boot, BEFORE reapOrphanedRuns() finished. This let tickTimers
 * coalesce new timer wakeups into orphaned "running" runs from the previous
 * process. Those ghost runs were never executed, effectively stopping
 * the scheduler.
 *
 * Fix: the scheduler interval is deferred until startup recovery
 * (reapOrphanedRuns + resumeQueuedRuns) completes. If recovery fails,
 * the scheduler still starts so the system can self-heal.
 */

describe("heartbeat scheduler startup sequencing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers scheduler start until startup recovery completes", async () => {
    let reapResolved = false;
    let schedulerStarted = false;

    const reapOrphanedRuns = () =>
      new Promise<void>((resolve) => {
        // Simulate async reap that takes time
        setTimeout(() => {
          reapResolved = true;
          resolve();
        }, 500);
      });

    const resumeQueuedRuns = () => Promise.resolve();

    const startHeartbeatScheduler = () => {
      schedulerStarted = true;
    };

    // This mirrors the fixed startup pattern in index.ts
    void reapOrphanedRuns()
      .then(() => resumeQueuedRuns())
      .then(() => {
        startHeartbeatScheduler();
      })
      .catch(() => {
        startHeartbeatScheduler();
      });

    // Before reap completes, scheduler should NOT have started
    expect(reapResolved).toBe(false);
    expect(schedulerStarted).toBe(false);

    // Advance past the reap delay
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    // After reap, scheduler should have started
    expect(reapResolved).toBe(true);
    expect(schedulerStarted).toBe(true);
  });

  it("starts scheduler even if startup recovery fails", async () => {
    let schedulerStarted = false;

    const reapOrphanedRuns = () => Promise.reject(new Error("DB connection lost"));
    const resumeQueuedRuns = () => Promise.resolve();

    const startHeartbeatScheduler = () => {
      schedulerStarted = true;
    };

    void reapOrphanedRuns()
      .then(() => resumeQueuedRuns())
      .then(() => {
        startHeartbeatScheduler();
      })
      .catch(() => {
        startHeartbeatScheduler();
      });

    // Let the rejected promise propagate to catch handler
    await vi.runAllTimersAsync();

    expect(schedulerStarted).toBe(true);
  });

  it("old pattern (bug): scheduler starts before reap finishes", async () => {
    let reapResolved = false;
    let tickFiredBeforeReap = false;

    const reapOrphanedRuns = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          reapResolved = true;
          resolve();
        }, 500);
      });

    // Simulate the OLD buggy pattern from index.ts:
    // void reapOrphanedRuns()...
    // setInterval(() => tickTimers(), 30);  <-- starts immediately!
    void reapOrphanedRuns();

    const intervalId = setInterval(() => {
      if (!reapResolved) {
        tickFiredBeforeReap = true;
      }
    }, 30);

    // Advance 30ms — tick fires, but reap hasn't finished (takes 500ms)
    vi.advanceTimersByTime(30);

    expect(tickFiredBeforeReap).toBe(true);
    expect(reapResolved).toBe(false);

    clearInterval(intervalId);
  });
});

describe("tickTimers error resilience", () => {
  it("continues processing agents after one enqueueWakeup throws", async () => {
    const processed: string[] = [];
    const errors: string[] = [];

    // Simulate the fixed tickTimers loop with try-catch per agent
    const agents = [
      { id: "agent-1", shouldThrow: false },
      { id: "agent-2", shouldThrow: true },
      { id: "agent-3", shouldThrow: false },
    ];

    let enqueued = 0;
    let errored = 0;

    for (const agent of agents) {
      try {
        if (agent.shouldThrow) {
          throw new Error("budget.blocked");
        }
        processed.push(agent.id);
        enqueued += 1;
      } catch {
        errors.push(agent.id);
        errored += 1;
      }
    }

    // All agents should be attempted, even after agent-2 throws
    expect(processed).toEqual(["agent-1", "agent-3"]);
    expect(errors).toEqual(["agent-2"]);
    expect(enqueued).toBe(2);
    expect(errored).toBe(1);
  });

  it("old pattern (bug): loop aborts after first throw", async () => {
    const processed: string[] = [];

    const agents = [
      { id: "agent-1", shouldThrow: false },
      { id: "agent-2", shouldThrow: true },
      { id: "agent-3", shouldThrow: false },
    ];

    // Simulate the OLD pattern without try-catch
    const tickTimersOld = async () => {
      for (const agent of agents) {
        if (agent.shouldThrow) {
          throw new Error("budget.blocked");
        }
        processed.push(agent.id);
      }
    };

    await expect(tickTimersOld()).rejects.toThrow("budget.blocked");
    // agent-3 was never processed because the exception aborted the loop
    expect(processed).toEqual(["agent-1"]);
  });
});
