import { describe, it, expect, vi } from "vitest";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventHandler = (event: { pluginId: string }) => void;

function makeLifecycle() {
  const handlers: Map<string, EventHandler> = new Map();
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    emit: (event: string, payload: { pluginId: string }) => {
      handlers.get(event)?.(payload);
    },
  };
}

// ---------------------------------------------------------------------------
// createPluginHostServiceCleanup
// ---------------------------------------------------------------------------

describe("createPluginHostServiceCleanup", () => {
  it("registers lifecycle listeners on creation", () => {
    const lifecycle = makeLifecycle();
    const disposers = new Map<string, () => void>();
    createPluginHostServiceCleanup(lifecycle, disposers);
    expect(lifecycle.on).toHaveBeenCalledWith("plugin.worker_stopped", expect.any(Function));
    expect(lifecycle.on).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
  });

  // -------------------------------------------------------------------------
  // handleWorkerEvent
  // -------------------------------------------------------------------------

  it("handleWorkerEvent: calls disposer when type is 'plugin.worker.crashed'", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["my-plugin", dispose]]);
    const ctrl = createPluginHostServiceCleanup(lifecycle, disposers);

    ctrl.handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "my-plugin" });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("handleWorkerEvent: does NOT call disposer when type is 'plugin.worker.restarted'", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["my-plugin", dispose]]);
    const ctrl = createPluginHostServiceCleanup(lifecycle, disposers);

    ctrl.handleWorkerEvent({ type: "plugin.worker.restarted", pluginId: "my-plugin" });

    expect(dispose).not.toHaveBeenCalled();
  });

  it("handleWorkerEvent: is a no-op when there is no disposer for the plugin", () => {
    const lifecycle = makeLifecycle();
    const ctrl = createPluginHostServiceCleanup(lifecycle, new Map());
    expect(() => ctrl.handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "unknown" })).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Lifecycle event: plugin.worker_stopped
  // -------------------------------------------------------------------------

  it("calls disposer (but keeps it) when plugin.worker_stopped fires", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["plugin-x", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    lifecycle.emit("plugin.worker_stopped", { pluginId: "plugin-x" });

    expect(dispose).toHaveBeenCalledOnce();
    // Disposer remains in the map (plugin can restart)
    expect(disposers.has("plugin-x")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Lifecycle event: plugin.unloaded
  // -------------------------------------------------------------------------

  it("calls disposer AND removes it when plugin.unloaded fires", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["plugin-y", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    lifecycle.emit("plugin.unloaded", { pluginId: "plugin-y" });

    expect(dispose).toHaveBeenCalledOnce();
    expect(disposers.has("plugin-y")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // disposeAll
  // -------------------------------------------------------------------------

  it("disposeAll: calls all disposers and clears the map", () => {
    const lifecycle = makeLifecycle();
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const disposers = new Map([["a", disposeA], ["b", disposeB]]);
    const ctrl = createPluginHostServiceCleanup(lifecycle, disposers);

    ctrl.disposeAll();

    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).toHaveBeenCalledOnce();
    expect(disposers.size).toBe(0);
  });

  it("disposeAll: is a no-op when map is empty", () => {
    const lifecycle = makeLifecycle();
    const ctrl = createPluginHostServiceCleanup(lifecycle, new Map());
    expect(() => ctrl.disposeAll()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // teardown
  // -------------------------------------------------------------------------

  it("teardown: unregisters the lifecycle listeners", () => {
    const lifecycle = makeLifecycle();
    const ctrl = createPluginHostServiceCleanup(lifecycle, new Map());
    ctrl.teardown();
    expect(lifecycle.off).toHaveBeenCalledWith("plugin.worker_stopped", expect.any(Function));
    expect(lifecycle.off).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
  });
});
