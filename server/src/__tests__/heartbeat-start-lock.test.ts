import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.ts";
import { AGENT_START_LOCK_STALE_MS, withAgentStartLock } from "../services/agent-start-lock.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not let a stale start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const agentId = randomUUID();
    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AGENT_START_LOCK_STALE_MS);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
    // A holder that stops renewing for the whole lease window is treated as
    // hung, so the queued run still gets its start.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId }),
      "agent start lock stale; continuing queued-run start",
    );
  });

  it("keeps a slow but progressing start on its lease without a duplicate start (AUT-5348)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const agentId = randomUUID();
    // Reproduce the EP6 case: a start that takes well past the old 30s lease
    // (measured 9.9-35s) while renewing at each phase boundary, the way
    // startNextQueuedRunForAgent does. The test drives the clock through step()
    // so fake-timer advances never nest inside the holder.
    let phase = 0;
    let step = async () => true;
    const firstStart = vi.fn(async (lease: { renew: () => void }) => {
      for (;;) {
        lease.renew();
        if (!(await step())) return "first";
      }
    });
    step = async () => {
      phase += 1;
      if (phase > 8) return false;
      await vi.advanceTimersByTimeAsync(5_000);
      return true;
    };
    const secondStart = vi.fn(async () => "second");

    const firstResult = withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();

    // Mid-start checkpoint at 35s: past the old 30s lease, first start still
    // in flight, so no queued run may start behind it.
    for (let elapsed = 0; elapsed < 35_000; elapsed += 5_000) await step();
    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondStart).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    // Start finishes at 40s, releasing the lock to the queued run.
    await step();
    await expect(firstResult).resolves.toBe("first");
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await expect(secondResult).resolves.toBe("second");
    // Exactly one second start, released only after the slow start finished.
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a queued holder's own lease alive so a third start cannot jump it (AUT-5348)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const agentId = randomUUID();
    let clockMs = 0;
    // Each holder advances the shared fake clock in 5s phase boundaries, the
    // way startNextQueuedRunForAgent does.
    const holdFor = async (lease: { renew: () => void }, durationMs: number) => {
      const startedAtMs = clockMs;
      while (clockMs - startedAtMs < durationMs) {
        lease.renew();
        clockMs += 5_000;
        await vi.advanceTimersByTimeAsync(5_000);
      }
    };
    const firstStart = vi.fn(async (lease: { renew: () => void }) => {
      await holdFor(lease, 60_000);
      return "first";
    });
    const secondStart = vi.fn(async (lease: { renew: () => void }) => {
      await holdFor(lease, 45_000);
      return "second";
    });
    const thirdStart = vi.fn(async () => "third");

    const firstResult = withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    const secondResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    const thirdResult = withAgentStartLock(agentId, thirdStart);
    await Promise.resolve();

    // The first start runs 60s, twice the old 30s lease. The second caller is
    // only queued the whole time, so its own lease must renew while it waits or
    // the third caller reads it stale and starts behind the running start.
    await expect(firstResult).resolves.toBe("first");
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(thirdStart).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    // The second start then holds 45s, also past the old lease, and the
    // third caller stays queued behind it until it finishes.
    await expect(secondResult).resolves.toBe("second");
    expect(thirdStart).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    await expect(thirdResult).resolves.toBe("third");
    expect(thirdStart).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});