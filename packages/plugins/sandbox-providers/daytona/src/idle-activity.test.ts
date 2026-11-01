import { describe, expect, it } from "vitest";
import { DaytonaIdleActivity, trackDaytonaHooks } from "./idle-activity.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Daytona idle evidence", () => {
  it("keeps the underlying request after its caller's deadline", async () => {
    const activity = new DaytonaIdleActivity();
    const request = deferred();
    const pending = activity.track(() => request.promise);
    await Promise.race([pending, Promise.resolve("deadline")]);
    expect(activity.present()).toBe(true);
    request.resolve();
    await pending;
    expect(activity.present()).toBe(false);
  });

  it("settles rejected requests and synchronous failures", async () => {
    const activity = new DaytonaIdleActivity();
    await expect(activity.track(() => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    expect(() => activity.track(() => { throw new Error("sync"); })).toThrow("sync");
    expect(activity.present()).toBe(false);
  });

  it("does not treat absence of an unobserved creation name as deletion", () => {
    const activity = new DaytonaIdleActivity();
    const allocation = activity.resource("account/company/environment/create-name", true);
    activity.confirm(activity.proof("account/company/environment/create-name"), true);
    expect(activity.present()).toBe(true);
    activity.observe(allocation, "account/company/environment/immutable-id");
    activity.confirm(activity.proof("account/company/environment/immutable-id"), true);
    expect(activity.present()).toBe(false);
    activity.observe(allocation, "account/company/environment/immutable-id");
    expect(activity.present()).toBe(false);
  });

  it("clears aliases only for the resource with exact scope and cleanup proof", () => {
    const activity = new DaytonaIdleActivity();
    const allocation = activity.resource("account-a/company-a/environment-a/create", true);
    activity.observe(allocation, "account-a/company-a/environment-a/id");
    for (const key of ["account-b/company-a/environment-a/id", "account-a/company-b/environment-a/id", "account-a/company-a/environment-b/id"]) {
      activity.resource(key);
    }
    activity.confirm(activity.proof("account-a/company-a/environment-a/id"));
    expect(activity.present()).toBe(true);
    for (const key of ["account-b/company-a/environment-a/id", "account-a/company-b/environment-a/id", "account-a/company-a/environment-b/id"]) {
      activity.confirm(activity.proof(key));
    }
    expect(activity.present()).toBe(false);
  });

  it("requires another receipt after overlapping work settles", async () => {
    const activity = new DaytonaIdleActivity();
    activity.resource("resource");
    const request = deferred();
    const pending = activity.track(() => { activity.resource("resource"); return request.promise; });
    await activity.track(async () => { activity.confirm(activity.proof("resource")); });
    expect(activity.present()).toBe(true);
    request.resolve();
    await pending;
    expect(activity.present()).toBe(true);
    await activity.track(async () => { activity.confirm(activity.proof("resource"), true); });
    expect(activity.present()).toBe(false);
  });

  it("clears unrelated cleanup concurrently without losing pending work", async () => {
    const activity = new DaytonaIdleActivity();
    const unrelated = deferred();
    const pending = activity.track(() => { activity.resource("other"); return unrelated.promise; });
    await activity.track(async () => {
      activity.resource("cleaned");
      activity.confirm(activity.proof("cleaned"));
    });
    unrelated.resolve(); await pending;
    activity.confirm(activity.proof("other"));
    expect(activity.present()).toBe(false);
  });

  it("does not mistake a timed-out child request for the receipt's own completed work", async () => {
    const activity = new DaytonaIdleActivity();
    const child = deferred();
    let pending!: Promise<void>;
    await activity.track(async () => {
      activity.resource("resource");
      pending = activity.track(() => child.promise);
      await Promise.race([pending, Promise.resolve()]);
      activity.confirm(activity.proof("resource"));
    });
    child.resolve(); await pending;
    expect(activity.present()).toBe(true);
    activity.confirm(activity.proof("resource"));
    expect(activity.present()).toBe(false);
  });

  it("rejects a stopped observation when overlapping work finishes before the reply", async () => {
    const activity = new DaytonaIdleActivity();
    const finishWork = deferred(), reply = deferred();
    const pending = activity.track(() => { activity.resource("resource"); return finishWork.promise; });
    const stoppedObservation = activity.track(async () => {
      const proof = activity.proof("resource");
      await reply.promise;
      activity.confirm(proof, true);
    });
    finishWork.resolve(); await pending;
    reply.resolve(); await stoppedObservation;
    expect(activity.present()).toBe(true);
    await activity.track(async () => { activity.confirm(activity.proof("resource"), true); });
    expect(activity.present()).toBe(false);
  });

  it("rejects proof captured before another resource generation was admitted", () => {
    const activity = new DaytonaIdleActivity();
    activity.resource("resource");
    const old = activity.proof("resource");
    activity.confirm(old);
    activity.resource("resource");
    activity.confirm(old);
    expect(activity.present()).toBe(true);
  });

  it("does not let a late create callback clear a new generation of the same ID", () => {
    const activity = new DaytonaIdleActivity();
    const old = activity.resource("resource");
    activity.confirm(activity.proof("resource"));
    activity.resource("resource");
    activity.observe(old, "late-alias");
    activity.confirm(activity.proof("late-alias"));
    expect(activity.present()).toBe(true);
    activity.confirm(activity.proof("resource"));
    expect(activity.present()).toBe(false);
  });

  it("tracks hook setup before a terminal is registered without blocking its own idle check", async () => {
    const activity = new DaytonaIdleActivity();
    const setup = deferred();
    const definition = trackDaytonaHooks({
      setup: async () => {},
      onHealth: async () => ({ status: "ok" as const }),
      onIdleDrain: async () => activity.present() ? "present" as const : "none" as const,
      onShutdown: () => setup.promise,
    }, activity);
    const pending = definition.onShutdown!();
    expect(await definition.onIdleDrain!(new AbortController().signal)).toBe("present");
    setup.resolve();
    await pending;
    expect(await definition.onIdleDrain!(new AbortController().signal)).toBe("none");
  });

  it("does not let a completion from a reset test clear a newer pending request", async () => {
    const activity = new DaytonaIdleActivity();
    const old = deferred(), current = deferred();
    const prior = activity.track(() => old.promise);
    activity.resetForTest();
    const pending = activity.track(() => current.promise);
    old.resolve(); await prior;
    expect(activity.present()).toBe(true);
    current.resolve(); await pending;
    expect(activity.present()).toBe(false);
  });
});
