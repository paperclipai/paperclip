import { describe, expect, it, vi } from "vitest";
import { createSingleFlight, createTrackedSingleFlight } from "./single-flight.js";
import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  it("runs work when idle and reports busy until it settles", async () => {
    const gate = createSingleFlight();
    const gap = deferred();

    const first = gate.run(() => gap.promise);
    expect(first.started).toBe(true);
    expect(gate.busy).toBe(true);

    gap.resolve();
    await (first as { settled: Promise<void> }).settled;
    expect(gate.busy).toBe(false);
  });

  it("skips a tick while the previous invocation is still in flight", async () => {
    const clock = { nowMs: 1_000 };
    const gate = createSingleFlight(() => clock.nowMs);
    const gap = deferred();
    const work = vi.fn(() => gap.promise);

    const first = gate.run(work);
    clock.nowMs = 31_000;
    const second = gate.run(work);

    expect(second).toEqual({ started: false, inFlightForMs: 30_000 });
    expect(work).toHaveBeenCalledTimes(1);

    gap.resolve();
    await (first as { settled: Promise<void> }).settled;
  });

  it("admits new work after the previous invocation resolves", async () => {
    const gate = createSingleFlight();
    const gap = deferred();

    const first = gate.run(() => gap.promise);
    gap.resolve();
    await (first as { settled: Promise<void> }).settled;

    const second = gate.run(async () => {});
    expect(second.started).toBe(true);
    await (second as { settled: Promise<void> }).settled;
  });

  it("releases the gate when work rejects and never rejects the settled promise", async () => {
    const gate = createSingleFlight();
    const gap = deferred();

    const first = gate.run(() => gap.promise);
    gap.reject(new Error("chain failed"));
    await expect((first as { settled: Promise<void> }).settled).resolves.toBeUndefined();
    expect(gate.busy).toBe(false);

    const second = gate.run(async () => {});
    expect(second.started).toBe(true);
    await (second as { settled: Promise<void> }).settled;
  });

  it("propagates a synchronous throw and leaves the gate free", async () => {
    const gate = createSingleFlight();

    expect(() =>
      gate.run(() => {
        throw new Error("sync failure");
      }),
    ).toThrow("sync failure");
    expect(gate.busy).toBe(false);

    const second = gate.run(async () => {});
    expect(second.started).toBe(true);
    await (second as { settled: Promise<void> }).settled;
  });

  it("keeps the owned pass active after a caller stops waiting", async () => {
    const gate = createSingleFlight(), work = deferred(), observer = deferred();
    const first = gate.run(() => work.promise);
    if (!first.started) throw new Error("initial pass was not admitted");
    const stopped = Promise.race([first.settled, observer.promise]);
    observer.reject(new Error("observer stopped"));
    await expect(stopped).rejects.toThrow("observer stopped");
    const duplicate = vi.fn(async () => undefined);
    expect(gate.run(duplicate).started).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    expect(gate.busy).toBe(true);
    work.resolve();
    await first.settled;
    expect(gate.busy).toBe(false);
  });

  it("keeps cleanup joined after the main operation completes", async () => {
    const gate = createSingleFlight(), operation = deferred(), cleanup = deferred();
    const first = gate.run(() => operation.promise.finally(() => cleanup.promise));
    if (!first.started) throw new Error("initial pass was not admitted");
    operation.resolve();
    await Promise.resolve();
    expect(gate.busy).toBe(true);
    const duplicate = vi.fn(async () => undefined);
    expect(gate.run(duplicate).started).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    cleanup.resolve();
    await first.settled;
    expect(gate.busy).toBe(false);
    const next = gate.run(duplicate);
    expect(next.started).toBe(true);
    if (next.started) await next.settled;
    expect(duplicate).toHaveBeenCalledTimes(1);
  });

  it("tracks one periodic pass through scheduler shutdown and idle sleep", async () => {
    vi.useFakeTimers();
    const before = idleWorkSnapshot().active;
    const operation = deferred(), cleanup = deferred();
    const tracked: Promise<void>[] = [];
    const trackWork = vi.fn((work: Promise<void>) => {
      const finish = beginIdleTrackedWork();
      tracked.push(work.finally(finish));
    });
    const onSkipped = vi.fn();
    const tick = createTrackedSingleFlight({ trackWork, onSkipped });
    const heartbeat = vi.fn(() => operation.promise.finally(() => cleanup.promise));
    const timer = setInterval(() => tick(heartbeat), 30_000);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(trackWork).toHaveBeenCalledOnce();
      expect(onSkipped).toHaveBeenCalledExactlyOnceWith(30_000);
      clearInterval(timer);
      let shutdownComplete = false;
      const shutdown = Promise.all(tracked).then(() => { shutdownComplete = true; });
      await Promise.resolve();
      expect(shutdownComplete).toBe(false);
      expect(idleWorkSnapshot().active).toBe(before + 1);
      operation.resolve();
      await Promise.resolve();
      expect(shutdownComplete).toBe(false);
      expect(idleWorkSnapshot().active).toBe(before + 1);
      cleanup.resolve();
      await shutdown;
      expect(shutdownComplete).toBe(true);
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      clearInterval(timer);
      operation.resolve();
      cleanup.resolve();
      await Promise.all(tracked);
      vi.useRealTimers();
    }
  });
});
