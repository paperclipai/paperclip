import { describe, expect, it } from "vitest";
import { createToolDiscoveryScheduler } from "./tool-discovery-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("tool discovery admission", () => {
  it("bounds whole listings and rejects excess queued requests", async () => {
    const scheduler = createToolDiscoveryScheduler(2, 2);
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    };
    const accepted = Array.from({ length: 4 }, () => scheduler.run(work));
    await expect(scheduler.run(work)).rejects.toMatchObject({ name: "ToolDiscoveryBusyError" });
    expect(active).toBe(2);
    gate.resolve();
    await Promise.all(accepted);
    expect(peak).toBe(2);
    await scheduler.run(async () => {});
  });

  it("removes abandoned queued requests and releases slots after failures", async () => {
    const scheduler = createToolDiscoveryScheduler(1, 1);
    const gate = deferred();
    const first = scheduler.run(() => gate.promise);
    const controller = new AbortController();
    let abandonedStarted = false;
    const abandoned = scheduler.run(async () => { abandonedStarted = true; }, controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    const next = scheduler.run(async () => { throw new Error("Read failed"); });
    const failure = expect(next).rejects.toThrow("Read failed");
    gate.resolve();
    await first;
    await failure;
    expect(abandonedStarted).toBe(false);
    await scheduler.run(async () => {});
  });
});
