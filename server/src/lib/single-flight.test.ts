import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "./single-flight.js";

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
});
