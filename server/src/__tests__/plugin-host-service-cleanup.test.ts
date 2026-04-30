import { describe, expect, it, vi } from "vitest";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";

type LifecycleStub = {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  handler(event: "plugin.worker_stopped" | "plugin.unloaded"): ((payload: { pluginId: string }) => void) | undefined;
};

function createLifecycleStub(): LifecycleStub {
  const on = vi.fn();
  const off = vi.fn();
  return {
    on,
    off,
    handler(event) {
      const call = on.mock.calls.find(([name]) => name === event);
      return call?.[1] as ((payload: { pluginId: string }) => void) | undefined;
    },
  };
}

describe("plugin-host-service-cleanup", () => {
  it("disposes plugin host services when a worker crashes", () => {
    const dispose = vi.fn();
    const disposers = new Map<string, () => void>([["plugin-1", dispose]]);
    const cleanup = createPluginHostServiceCleanup(createLifecycleStub(), disposers);

    cleanup.handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledTimes(1);
    // The disposer is intentionally retained: a crashed worker is auto-restarted
    // by the worker manager and the next start re-registers a fresh disposer.
    expect(disposers.has("plugin-1")).toBe(true);
  });

  it("ignores plugin.worker.restarted events", () => {
    const dispose = vi.fn();
    const disposers = new Map<string, () => void>([["plugin-1", dispose]]);
    const cleanup = createPluginHostServiceCleanup(createLifecycleStub(), disposers);

    cleanup.handleWorkerEvent({ type: "plugin.worker.restarted", pluginId: "plugin-1" });

    expect(dispose).not.toHaveBeenCalled();
  });

  it("is a no-op when no disposer is registered for the plugin", () => {
    const cleanup = createPluginHostServiceCleanup(createLifecycleStub(), new Map());

    expect(() =>
      cleanup.handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "unknown" }),
    ).not.toThrow();
  });

  it("disposes when the worker is stopped via the lifecycle manager (graceful path)", () => {
    const lifecycle = createLifecycleStub();
    const dispose = vi.fn();
    const disposers = new Map<string, () => void>([["plugin-1", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    const handler = lifecycle.handler("plugin.worker_stopped");
    expect(handler).toBeDefined();
    handler?.({ pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposers.has("plugin-1")).toBe(true);
  });

  it("disposes and removes the disposer when the plugin is unloaded", () => {
    const lifecycle = createLifecycleStub();
    const dispose = vi.fn();
    const disposers = new Map<string, () => void>([["plugin-1", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    const handler = lifecycle.handler("plugin.unloaded");
    expect(handler).toBeDefined();
    handler?.({ pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposers.has("plugin-1")).toBe(false);
  });

  it("disposeAll runs every registered disposer and clears the map", () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const disposers = new Map<string, () => void>([
      ["plugin-a", disposeA],
      ["plugin-b", disposeB],
    ]);
    const cleanup = createPluginHostServiceCleanup(createLifecycleStub(), disposers);

    cleanup.disposeAll();

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(disposers.size).toBe(0);
  });

  it("invokes the disposer twice when a crash is followed by a manual stop during backoff", () => {
    // A crashed worker auto-restarts and the entry stays in the disposer
    // map so the new instance can run its own dispose later. If the
    // operator manually disables or unloads the plugin while the worker
    // is still in the backoff window, the lifecycle-driven graceful path
    // (`plugin.worker_stopped`) will trigger another dispose for the same
    // entry. The cleanup controller intentionally does not deduplicate;
    // the contract is that registered disposers (built by
    // `buildHostServices`) are idempotent. This test pins that contract:
    // both invocations must succeed and the disposer must be called twice.
    const lifecycle = createLifecycleStub();
    const dispose = vi.fn();
    const disposers = new Map<string, () => void>([["plugin-1", dispose]]);
    const cleanup = createPluginHostServiceCleanup(lifecycle, disposers);

    cleanup.handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "plugin-1" });
    expect(dispose).toHaveBeenCalledTimes(1);

    const handler = lifecycle.handler("plugin.worker_stopped");
    expect(() => handler?.({ pluginId: "plugin-1" })).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("teardown unregisters the lifecycle listeners it installed", () => {
    const lifecycle = createLifecycleStub();
    const cleanup = createPluginHostServiceCleanup(lifecycle, new Map());

    cleanup.teardown();

    const stoppedHandler = lifecycle.on.mock.calls.find(
      ([name]) => name === "plugin.worker_stopped",
    )?.[1];
    const unloadedHandler = lifecycle.on.mock.calls.find(
      ([name]) => name === "plugin.unloaded",
    )?.[1];

    expect(lifecycle.off).toHaveBeenCalledWith("plugin.worker_stopped", stoppedHandler);
    expect(lifecycle.off).toHaveBeenCalledWith("plugin.unloaded", unloadedHandler);
  });
});
