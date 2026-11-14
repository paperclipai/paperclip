import { describe, expect, it } from "vitest";
import { hasConnectionEventWakeReceiver, joinConnectionEventWakeEnrollment, registerConnectionEventWake, wakeConnectionEvents } from "./connection-event-wake.js";

function deferred() { let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe("registered connection event enrollment joins", () => {
  it("shares one underlying frontier and rejects it on unregister without granting capability", async () => {
    const owner = {}, gate = deferred(); let signal: AbortSignal | undefined, wakes = 0;
    const stop = registerConnectionEventWake(owner, () => { wakes++; }, { canRun: () => true, join: active => { signal = active; return gate.promise; } });
    try {
      expect(hasConnectionEventWakeReceiver(owner)).toBe(true); expect(wakeConnectionEvents(owner)).toBe(true); expect(wakes).toBe(1);
      const first = joinConnectionEventWakeEnrollment(owner), second = joinConnectionEventWakeEnrollment(owner);
      expect(second).toBe(first);
      const rejected = expect(first).rejects.toThrow("unregistered"); stop(); await rejected;
      expect(signal?.aborted).toBe(true); expect(hasConnectionEventWakeReceiver(owner)).toBe(false);
      await expect(joinConnectionEventWakeEnrollment(owner)).rejects.toThrow("unavailable");
    } finally { stop(); gate.resolve(); }
  });

  it("does not let old owner completion authorize a replacement or bypass canRun", async () => {
    const owner = {}, old = deferred(), fresh = deferred(); let allowed = true;
    const stopOld = registerConnectionEventWake(owner, () => undefined, { canRun: () => true, join: () => old.promise });
    const stale = joinConnectionEventWakeEnrollment(owner), refusedOld = expect(stale).rejects.toThrow("unregistered");
    const stopFresh = registerConnectionEventWake(owner, () => undefined, { canRun: () => allowed, join: () => fresh.promise });
    try {
      await refusedOld; old.reject(new Error("old unrelated drain failure"));
      const current = joinConnectionEventWakeEnrollment(owner), refusedCurrent = expect(current).rejects.toThrow("changed");
      allowed = false; fresh.resolve(); await refusedCurrent;
      await expect(joinConnectionEventWakeEnrollment(owner)).rejects.toThrow("unavailable");
    } finally { stopOld(); stopFresh(); old.resolve(); fresh.resolve(); }
  });
});
