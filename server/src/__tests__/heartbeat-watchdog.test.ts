import { describe, expect, it } from "vitest";
import { createRunWatchdog } from "../services/heartbeat.ts";

describe("createRunWatchdog", () => {
  it("rejects when abort() is called externally — the reaper-after-process-loss path", async () => {
    const watchdog = createRunWatchdog({ timeoutMs: 60_000 });
    try {
      const onAdapterHang = new Promise(() => {}); // never settles
      const racePromise = Promise.race([onAdapterHang, watchdog.promise]);
      watchdog.abort("process_lost: child pid 999 is no longer running");
      await expect(racePromise).rejects.toMatchObject({
        message: expect.stringContaining("process_lost"),
        code: "watchdog_aborted",
      });
    } finally {
      watchdog.cleanup();
    }
  });

  it("rejects when the hard timeout elapses — the no-reaper-tick fallback", async () => {
    const watchdog = createRunWatchdog({ timeoutMs: 50 });
    try {
      const onAdapterHang = new Promise(() => {});
      const racePromise = Promise.race([onAdapterHang, watchdog.promise]);
      await expect(racePromise).rejects.toMatchObject({
        message: expect.stringContaining("hard timeout"),
        code: "watchdog_aborted",
      });
    } finally {
      watchdog.cleanup();
    }
  });

  it("calls onAbort callback exactly once with the abort reason", async () => {
    const reasons: string[] = [];
    const watchdog = createRunWatchdog({
      timeoutMs: 60_000,
      onAbort: (reason) => reasons.push(reason),
    });
    try {
      watchdog.promise.catch(() => undefined);
      watchdog.abort("first");
      watchdog.abort("second");
      expect(reasons).toEqual(["first"]);
    } finally {
      watchdog.cleanup();
    }
  });

  it("does not fire when the adapter resolves first — the happy path", async () => {
    const watchdog = createRunWatchdog({ timeoutMs: 60_000 });
    try {
      const adapterResult = Promise.resolve({ ok: true });
      const racePromise = Promise.race([adapterResult, watchdog.promise]);
      const result = await racePromise;
      expect(result).toEqual({ ok: true });
    } finally {
      watchdog.cleanup();
    }
  });

  it("cleanup() prevents the timer from firing after the race already settled", async () => {
    const reasons: string[] = [];
    const watchdog = createRunWatchdog({
      timeoutMs: 30,
      onAbort: (reason) => reasons.push(reason),
    });
    const adapterResult = Promise.resolve("done");
    await Promise.race([adapterResult, watchdog.promise]);
    watchdog.cleanup();
    await new Promise((r) => setTimeout(r, 80));
    expect(reasons).toEqual([]);
  });
});
