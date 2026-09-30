// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "./concurrency-limiter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createConcurrencyLimiter", () => {
  it("never runs more than `maxConcurrent` tasks at once", async () => {
    const limit = createConcurrencyLimiter(4);
    const gates = Array.from({ length: 20 }, () => deferred<string>());
    let active = 0;
    let peak = 0;

    const runs = gates.map((gate, index) =>
      limit(() => {
        active += 1;
        peak = Math.max(peak, active);
        return gate.promise.finally(() => {
          active -= 1;
        });
      }).then(() => index),
    );

    // Everything queued in one tick: only the first 4 may have started.
    await Promise.resolve();
    expect(peak).toBe(4);

    for (const gate of gates) gate.resolve("ok");
    await expect(Promise.all(runs)).resolves.toHaveLength(20);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it("frees the slot when a task rejects and still rejects the caller", async () => {
    const limit = createConcurrencyLimiter(1);
    const failure = limit(() => Promise.reject(new Error("boom")));
    await expect(failure).rejects.toThrow("boom");
    await expect(limit(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("frees the slot when a task throws synchronously", async () => {
    const limit = createConcurrencyLimiter(1);
    await expect(
      limit(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    await expect(limit(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/positive integer/);
  });
});
