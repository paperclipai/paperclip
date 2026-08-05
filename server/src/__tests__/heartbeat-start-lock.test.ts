import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock } from "../services/agent-start-lock.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("coalesces start attempts: only one may wait behind a hung holder; further attempts skip", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const hungStart = vi.fn(() => new Promise<void>(() => undefined));
    const waitingStart = vi.fn(async () => "waiter-started");
    const extraStart = vi.fn(async () => "extra-started");

    void withAgentStartLock(agentId, hungStart);
    await Promise.resolve();

    const waiterResult = withAgentStartLock(agentId, waitingStart);
    await Promise.resolve();

    // A third attempt while one waiter is already queued must skip without
    // running its callback — stacking is what turns one slow start into a
    // storm of concurrent claim+spawn sequences (#9360).
    const extraResult = withAgentStartLock(agentId, extraStart);
    await expect(extraResult).resolves.toBeUndefined();
    expect(extraStart).not.toHaveBeenCalled();

    // The single queued waiter still preserves liveness after the stale window.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiterResult).resolves.toBe("waiter-started");
    expect(waitingStart).toHaveBeenCalledTimes(1);
  });

  it("a skipped attempt does not disturb the lock: the next attempt after the waiter starts can wait normally", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const hungStart = vi.fn(() => new Promise<void>(() => undefined));
    const waitingStart = vi.fn(async () => "waiter-started");
    const skipped = vi.fn(async () => "skipped");
    const nextStart = vi.fn(async () => "next-started");

    void withAgentStartLock(agentId, hungStart);
    await Promise.resolve();
    const waiterResult = withAgentStartLock(agentId, waitingStart);
    await Promise.resolve();
    await expect(withAgentStartLock(agentId, skipped)).resolves.toBeUndefined();

    // Once the waiter takes over and runs, the waiter slot frees up: a new
    // attempt becomes the (single) waiter behind the now-running start.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiterResult).resolves.toBe("waiter-started");

    const nextResult = withAgentStartLock(agentId, nextStart);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(nextResult).resolves.toBe("next-started");
    expect(nextStart).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("serialises cleanly when the holder finishes normally: later attempts run without skipping", async () => {
    const agentId = randomUUID();

    let releaseFirst: () => void = () => undefined;
    const firstStart = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const secondStart = vi.fn(async () => "started");

    const firstResult = withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    const secondResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    releaseFirst();
    await firstResult;
    await expect(secondResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });
});
