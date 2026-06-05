import { describe, expect, it, vi, afterEach } from "vitest";
import { resumeQueuedAgentsWithTimeout } from "../services/queued-run-resume.ts";

describe("queued-run resume", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let one hung agent queue block other agents", async () => {
    vi.useFakeTimers();

    const start = vi.fn((agentId: string) => {
      if (agentId === "agent-a") return new Promise<unknown[]>(() => undefined);
      return Promise.resolve([{ id: `${agentId}-run` }]);
    });

    const resumed = resumeQueuedAgentsWithTimeout(["agent-a", "agent-b"], start, {
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(resumed).resolves.toEqual({
      checked: 2,
      started: 1,
      timedOut: 1,
      failed: 0,
      timedOutAgentIds: ["agent-a"],
      failedAgentIds: [],
    });
    expect(start).toHaveBeenCalledWith("agent-a");
    expect(start).toHaveBeenCalledWith("agent-b");
  });

  it("bounds concurrent queue resume attempts and continues after a timeout", async () => {
    vi.useFakeTimers();

    const start = vi.fn((agentId: string) => {
      if (agentId === "agent-a") return new Promise<unknown[]>(() => undefined);
      return Promise.resolve([{ id: `${agentId}-run` }]);
    });

    const resumed = resumeQueuedAgentsWithTimeout(["agent-a", "agent-b", "agent-c"], start, {
      concurrency: 1,
      timeoutMs: 100,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("agent-a");

    await vi.advanceTimersByTimeAsync(100);

    expect(start).toHaveBeenCalledWith("agent-b");
    expect(start).toHaveBeenCalledWith("agent-c");

    await expect(resumed).resolves.toEqual({
      checked: 3,
      started: 2,
      timedOut: 1,
      failed: 0,
      timedOutAgentIds: ["agent-a"],
      failedAgentIds: [],
    });
  });

  it("deduplicates agents before attempting queue resume", async () => {
    const start = vi.fn(async (agentId: string) => [{ id: `${agentId}-run` }]);

    await expect(resumeQueuedAgentsWithTimeout(["agent-a", "agent-a", "agent-b"], start)).resolves.toMatchObject({
      checked: 2,
      started: 2,
    });
    expect(start).toHaveBeenCalledTimes(2);
  });
});
