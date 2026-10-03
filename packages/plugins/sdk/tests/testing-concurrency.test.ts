import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-concurrency",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Concurrency",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

// ---------------------------------------------------------------------------
// The headline case: production plugin event delivery is concurrent (the
// event bus fans out with `Promise.all`, and the worker bridge dispatches
// `onEvent` without awaiting it), but a harness whose `emit` always awaits
// each handler in a strict sequence is strictly MORE serialized than
// production and can never reproduce a read-modify-write race. These two
// tests are the whole point of this change: the same racy handler passes
// under the harness's old (default) behavior and fails once the harness is
// told to deliver events the way production does.
// ---------------------------------------------------------------------------

describe("createTestHarness event dispatch reproduces production races", () => {
  const raceManifest = {
    ...manifest,
    capabilities: ["events.subscribe", "plugin.state.read", "plugin.state.write"],
  } satisfies PaperclipPluginManifestV1;

  const counterKey = { scopeKind: "company" as const, scopeId: "company-1", stateKey: "counter" };

  /** A handler with a classic lost-update bug: it reads `ctx.state`, awaits, then writes back a value derived from the stale read. */
  function registerCounterHandler(harness: ReturnType<typeof createTestHarness>) {
    harness.ctx.events.on("issue.created", async () => {
      const current = (await harness.ctx.state.get(counterKey)) as number | null;
      // Yield to the microtask queue between the read and the write. This is
      // exactly the window where a second, concurrently-dispatched handler
      // can interleave and clobber this handler's update.
      await Promise.resolve();
      await harness.ctx.state.set(counterKey, (current ?? 0) + 1);
    });
  }

  it("sequential emit() (the default) fully serializes each event, hiding the race — false confidence", async () => {
    const harness = createTestHarness({ manifest: raceManifest });
    registerCounterHandler(harness);

    await harness.emit("issue.created", { issueId: "issue-1" });
    await harness.emit("issue.created", { issueId: "issue-2" });

    expect(harness.getState(counterKey)).toBe(2);
  });

  it("emitConcurrent delivers both events at once, reproducing the lost update", async () => {
    const harness = createTestHarness({ manifest: raceManifest });
    registerCounterHandler(harness);

    await harness.emitConcurrent([
      { eventType: "issue.created", payload: { issueId: "issue-1" } },
      { eventType: "issue.created", payload: { issueId: "issue-2" } },
    ]);

    // Both handlers read the counter as 0 before either writes it back, so
    // the second write clobbers the first.
    expect(harness.getState(counterKey)).toBe(1);
  });

  it("eventDispatch: 'concurrent' interleaves multiple handlers registered on the same event", async () => {
    const harness = createTestHarness({
      manifest: raceManifest,
      eventDispatch: "concurrent",
    });
    const order: string[] = [];
    harness.ctx.events.on("issue.created", async () => {
      order.push("a:start");
      await Promise.resolve();
      order.push("a:end");
    });
    harness.ctx.events.on("issue.created", async () => {
      order.push("b:start");
      await Promise.resolve();
      order.push("b:end");
    });

    await harness.emit("issue.created", {});

    expect(order).toEqual(["a:start", "b:start", "a:end", "b:end"]);
  });

  it("emitConcurrent interleaves handlers across two different event types", async () => {
    const harness = createTestHarness({ manifest: raceManifest });
    const order: string[] = [];

    harness.ctx.events.on("issue.created", async () => {
      order.push("created:start");
      await Promise.resolve();
      order.push("created:end");
    });
    harness.ctx.events.on("issue.updated", async () => {
      order.push("updated:start");
      await Promise.resolve();
      order.push("updated:end");
    });

    await harness.emitConcurrent([
      { eventType: "issue.created", payload: {} },
      { eventType: "issue.updated", payload: {} },
    ]);

    // Both handlers start before either finishes.
    expect(order).toEqual(["created:start", "updated:start", "created:end", "updated:end"]);
  });
});

// ---------------------------------------------------------------------------
// Host call interception / fault injection
// ---------------------------------------------------------------------------

describe("createTestHarness host call faults", () => {
  const faultManifest = {
    ...manifest,
    capabilities: ["issues.create", "issues.update", "issues.read"],
  } satisfies PaperclipPluginManifestV1;

  it("faults.throwOn fails the call before its effect lands", async () => {
    const harness = createTestHarness({ manifest: faultManifest });
    const issue = await harness.ctx.issues.create({ companyId: "company-1", title: "Original" });

    harness.faults.throwOn("issues.update", new Error("host unavailable"));

    await expect(
      harness.ctx.issues.update(issue.id, { title: "Renamed" }, "company-1"),
    ).rejects.toThrow("host unavailable");

    const stored = await harness.ctx.issues.get(issue.id, "company-1");
    expect(stored?.title).toBe("Original");
  });

  it("faults.throwAfterOn fails the call after its effect has already landed", async () => {
    const harness = createTestHarness({ manifest: faultManifest });
    const issue = await harness.ctx.issues.create({ companyId: "company-1", title: "Original" });

    harness.faults.throwAfterOn("issues.update", new Error("ack lost"));

    await expect(
      harness.ctx.issues.update(issue.id, { title: "Renamed" }, "company-1"),
    ).rejects.toThrow("ack lost");

    const stored = await harness.ctx.issues.get(issue.id, "company-1");
    expect(stored?.title).toBe("Renamed");
  });

  it("faults.parkOn produces a deterministic interleaving between two calls", async () => {
    const harness = createTestHarness({ manifest: faultManifest });
    const issue = await harness.ctx.issues.create({ companyId: "company-1", title: "Original" });

    const handle = harness.faults.parkOn("issues.update");
    const order: string[] = [];

    const parked = harness.ctx.issues.update(issue.id, { title: "Parked" }, "company-1").then(() => {
      order.push("parked");
    });

    await handle.reached;
    // The parked call has been entered but its real effect hasn't run yet, so
    // a second, independent call can be observed completing first.
    await harness.ctx.issues.update(issue.id, { title: "Second" }, "company-1");
    order.push("second");
    expect(order).toEqual(["second"]);

    handle.release();
    await parked;

    expect(order).toEqual(["second", "parked"]);
    expect(harness.hostCalls.map((call) => call.path)).toEqual(["issues.create", "issues.update", "issues.update"]);
  });

  it("hostCalls records path, args, and seq for every ctx call in order", async () => {
    const harness = createTestHarness({ manifest: faultManifest });
    await harness.ctx.issues.create({ companyId: "company-1", title: "A" });
    await harness.ctx.issues.create({ companyId: "company-1", title: "B" });

    expect(harness.hostCalls).toHaveLength(2);
    expect(harness.hostCalls[0]).toMatchObject({ path: "issues.create", seq: 0 });
    expect(harness.hostCalls[0].args).toEqual([{ companyId: "company-1", title: "A" }]);
    expect(harness.hostCalls[1]).toMatchObject({ path: "issues.create", seq: 1 });
    expect(harness.hostCalls[1].args).toEqual([{ companyId: "company-1", title: "B" }]);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: with no new options passed, behavior is unchanged.
// ---------------------------------------------------------------------------

describe("createTestHarness host call interception is transparent by default", () => {
  const plainManifest = {
    ...manifest,
    capabilities: ["events.subscribe"],
  } satisfies PaperclipPluginManifestV1;

  it("does not change ctx.manifest identity or synchronous return values when no options are passed", () => {
    const harness = createTestHarness({ manifest: plainManifest });

    expect(harness.ctx.manifest).toBe(plainManifest);

    const unsubscribe = harness.ctx.events.on("issue.created", async () => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("keeps synchronous ctx methods synchronous even when an interceptor is configured", async () => {
    const seen: string[] = [];
    const harness = createTestHarness({
      manifest: { ...plainManifest, capabilities: ["events.subscribe", "issues.read"] },
      hostCallInterceptor: async (call, proceed) => {
        seen.push(call.path);
        return proceed();
      },
    });

    // `ctx.events.on` returns an unsubscribe callback synchronously. Plugin
    // cleanup code calls it directly, so it must never become a Promise.
    const unsubscribe = harness.ctx.events.on("issue.created", async () => {});
    expect(typeof unsubscribe).toBe("function");
    expect(unsubscribe).not.toBeInstanceOf(Promise);
    expect(() => unsubscribe()).not.toThrow();

    // Asynchronous host calls are still intercepted.
    await harness.ctx.issues.get("missing", "company-1");
    expect(seen).toContain("issues.get");

    // The synchronous call is recorded, it is just not routed through the interceptor.
    expect(harness.hostCalls.map((call) => call.path)).toContain("events.on");
    expect(seen).not.toContain("events.on");
  });

  it("returns reference-stable namespaces and methods so spies and toBe assertions work", () => {
    const harness = createTestHarness({ manifest: plainManifest });

    expect(harness.ctx.issues).toBe(harness.ctx.issues);
    expect(harness.ctx.issues.update).toBe(harness.ctx.issues.update);
    expect(harness.ctx.state.set).toBe(harness.ctx.state.set);
  });

  it("keeps default sequential emit() behavior unchanged for multiple handlers on one event", async () => {
    const harness = createTestHarness({ manifest: plainManifest });
    const order: string[] = [];

    harness.ctx.events.on("issue.created", async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
    });
    harness.ctx.events.on("issue.created", async () => {
      order.push("second:start");
      await Promise.resolve();
      order.push("second:end");
    });

    await harness.emit("issue.created", {});

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
