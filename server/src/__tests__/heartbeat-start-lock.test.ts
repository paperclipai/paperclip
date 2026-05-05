import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock, _resetCircuitBreakerForTesting } from "../services/agent-start-lock.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetCircuitBreakerForTesting();
  });

  it("does not let a stale start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  describe("circuit breaker (Change 4)", () => {
    // Helper: start N stuck locks concurrently then advance 30 s so all time out simultaneously.
    async function triggerConcurrentLockTimeouts(n: number) {
      const results: Promise<unknown>[] = [];
      for (let i = 0; i < n; i++) {
        const agentId = randomUUID();
        const stuck = vi.fn(() => new Promise<void>(() => undefined));
        // Each agent already has a stuck first lock so the second call waits.
        void withAgentStartLock(agentId, stuck);
        const waitingFn = vi.fn(async () => "done");
        results.push(withAgentStartLock(agentId, waitingFn));
      }
      await Promise.resolve();
      // All N locks are now waiting. Advance 30 s to trigger stale timeouts for all of them.
      await vi.advanceTimersByTimeAsync(30_000);
      // Let the settled promises propagate.
      await Promise.allSettled(results);
    }

    it("does not trigger SIGTERM below the 10-timeout threshold", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

      // 9 concurrent timeouts — one below the threshold.
      await triggerConcurrentLockTimeouts(9);

      await vi.runAllImmediatesAsync();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("triggers SIGTERM graceful restart when 10 lock timeouts occur within 60 seconds (Change 4)", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

      // 10 concurrent stale lock timeouts — all within a single 30 s window,
      // well within the 60 s circuit-breaker sliding window.
      await triggerConcurrentLockTimeouts(10);

      // Deliver the setImmediate that sends SIGTERM.
      await vi.runAllImmediatesAsync();
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    });

    it("does not fire SIGTERM a second time once the circuit breaker has already tripped", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

      await triggerConcurrentLockTimeouts(10);
      await vi.runAllImmediatesAsync();
      expect(killSpy).toHaveBeenCalledTimes(1);

      // More timeouts after the breaker has tripped should not produce additional kills.
      await triggerConcurrentLockTimeouts(5);
      await vi.runAllImmediatesAsync();
      expect(killSpy).toHaveBeenCalledTimes(1);
    });

    it("evicts old events outside the 60-second window so they do not contribute to the threshold", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

      // 5 timeouts at t=0 to t=30 s.
      await triggerConcurrentLockTimeouts(5);

      // Advance past the 60-second window so those events are no longer counted.
      await vi.advanceTimersByTimeAsync(61_000);

      // 5 more timeouts — window now only contains these 5, still below threshold.
      await triggerConcurrentLockTimeouts(5);

      await vi.runAllImmediatesAsync();
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
});
