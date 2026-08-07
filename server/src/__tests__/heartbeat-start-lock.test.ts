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

  it("caps the hung-start chain: when the holder AND its takeover both hang, later attempts skip until one settles", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    let releaseTakeover: () => void = () => undefined;
    const hungHolder = vi.fn(() => new Promise<void>(() => undefined));
    const hungTakeover = vi.fn(
      () => new Promise<string>((resolve) => {
        releaseTakeover = () => resolve("takeover-finished");
      }),
    );
    const blocked = vi.fn(async () => "blocked");
    const afterSettle = vi.fn(async () => "after-settle");

    void withAgentStartLock(agentId, hungHolder);
    await Promise.resolve();
    const takeoverResult = withAgentStartLock(agentId, hungTakeover);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hungTakeover).toHaveBeenCalledTimes(1);

    // Holder and takeover are both in flight. Every further attempt must skip,
    // however many stale windows pass — this is the unbounded-chain scenario.
    for (let i = 0; i < 3; i += 1) {
      await expect(withAgentStartLock(agentId, blocked)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(blocked).not.toHaveBeenCalled();

    // As soon as one in-flight start settles, admission resumes.
    releaseTakeover();
    await expect(takeoverResult).resolves.toBe("takeover-finished");
    const resumed = withAgentStartLock(agentId, afterSettle);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(resumed).resolves.toBe("after-settle");
    expect(afterSettle).toHaveBeenCalledTimes(1);
  });

  it("promotion is atomic: attempts scheduled around waiter promotion can never become a third start", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const hungHolder = vi.fn(() => new Promise<void>(() => undefined));
    const hungTakeover = vi.fn(() => new Promise<void>(() => undefined));
    const probeFn = vi.fn(async () => "probe");
    const probeResults: Array<Promise<unknown>> = [];

    void withAgentStartLock(agentId, hungHolder);
    await Promise.resolve();
    void withAgentStartLock(agentId, hungTakeover);
    await Promise.resolve();

    // Invariant guard: fire probes from a timer at the same instant as the
    // waiter's stale timeout, stepping one microtask at a time. Whatever the
    // interleaving around waiter promotion, no probe may pass admission and
    // become a third concurrent start. (Promotion clears the waiter slot and
    // records the in-flight start in one promise reaction, so there is no
    // state between the two guards for a probe to observe.)
    const probeBurst = new Promise<void>((resolve) => {
      setTimeout(async () => {
        for (let i = 0; i < 8; i += 1) {
          probeResults.push(withAgentStartLock(agentId, probeFn));
          await null;
        }
        resolve();
      }, 30_000);
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await probeBurst;
    expect(hungTakeover).toHaveBeenCalledTimes(1);

    // Give any wrongly admitted probe its own stale window to fire.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(probeResults);
    expect(probeFn).not.toHaveBeenCalled();
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
