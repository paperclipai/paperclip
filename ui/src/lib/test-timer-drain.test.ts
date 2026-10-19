import { afterEach, describe, expect, it, vi } from "vitest";
import { drainQueuedTimers } from "./test-timer-drain";

describe("drainQueuedTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only after the 0 ms timers queued before it have run", async () => {
    const ran: number[] = [];
    for (const n of [1, 2, 3]) setTimeout(() => ran.push(n), 0);
    await drainQueuedTimers();
    expect(ran).toEqual([1, 2, 3]);
  });

  it("resolves while a test's fake timers are installed: it never schedules on the fake clock", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    const outcome = await Promise.race([
      drainQueuedTimers().then(() => "drained"),
      new Promise((resolve) => realSetTimeout(() => resolve("stuck on the fake clock"), 500)),
    ]);
    expect(outcome).toBe("drained");
  });
});
