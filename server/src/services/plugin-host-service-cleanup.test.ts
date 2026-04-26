import { describe, expect, it, vi } from "vitest";
import { createPluginHostServiceCleanup } from "./plugin-host-service-cleanup.js";

type EventHandler = (payload: { pluginId: string }) => void;

function makeLifecycle() {
  const handlers = new Map<string, Set<EventHandler>>();
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: EventHandler) => {
      handlers.get(event)?.delete(handler);
    }),
    emit(event: string, payload: { pluginId: string }) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

// ============================================================================
// createPluginHostServiceCleanup — setup
// ============================================================================

describe("createPluginHostServiceCleanup — lifecycle registration", () => {
  it("registers plugin.worker_stopped listener on creation", () => {
    const lifecycle = makeLifecycle();
    createPluginHostServiceCleanup(lifecycle, new Map());
    expect(lifecycle.on).toHaveBeenCalledWith("plugin.worker_stopped", expect.any(Function));
  });

  it("registers plugin.unloaded listener on creation", () => {
    const lifecycle = makeLifecycle();
    createPluginHostServiceCleanup(lifecycle, new Map());
    expect(lifecycle.on).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
  });
});

// ============================================================================
// createPluginHostServiceCleanup — handleWorkerEvent
// ============================================================================

describe("createPluginHostServiceCleanup — handleWorkerEvent", () => {
  it("calls the disposer when event type is plugin.worker.crashed", () => {
    const dispose = vi.fn();
    const disposers = new Map([["plugin-1", dispose]]);
    const { handleWorkerEvent } = createPluginHostServiceCleanup(makeLifecycle(), disposers);

    handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does NOT call the disposer for plugin.worker.restarted", () => {
    const dispose = vi.fn();
    const disposers = new Map([["plugin-1", dispose]]);
    const { handleWorkerEvent } = createPluginHostServiceCleanup(makeLifecycle(), disposers);

    handleWorkerEvent({ type: "plugin.worker.restarted", pluginId: "plugin-1" });

    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not remove the disposer from the map on crashed (only invokes)", () => {
    const dispose = vi.fn();
    const disposers = new Map([["plugin-1", dispose]]);
    const { handleWorkerEvent } = createPluginHostServiceCleanup(makeLifecycle(), disposers);

    handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "plugin-1" });

    expect(disposers.has("plugin-1")).toBe(true);
  });

  it("does not throw when no disposer is registered for the plugin", () => {
    const { handleWorkerEvent } = createPluginHostServiceCleanup(makeLifecycle(), new Map());
    expect(() =>
      handleWorkerEvent({ type: "plugin.worker.crashed", pluginId: "unknown-plugin" }),
    ).not.toThrow();
  });
});

// ============================================================================
// createPluginHostServiceCleanup — lifecycle event handling
// ============================================================================

describe("createPluginHostServiceCleanup — lifecycle events", () => {
  it("calls disposer when plugin.worker_stopped fires", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    createPluginHostServiceCleanup(lifecycle, new Map([["plugin-1", dispose]]));

    lifecycle.emit("plugin.worker_stopped", { pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not remove disposer from map on plugin.worker_stopped", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["plugin-1", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    lifecycle.emit("plugin.worker_stopped", { pluginId: "plugin-1" });

    expect(disposers.has("plugin-1")).toBe(true);
  });

  it("calls disposer and removes it from map on plugin.unloaded", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const disposers = new Map([["plugin-1", dispose]]);
    createPluginHostServiceCleanup(lifecycle, disposers);

    lifecycle.emit("plugin.unloaded", { pluginId: "plugin-1" });

    expect(dispose).toHaveBeenCalledOnce();
    expect(disposers.has("plugin-1")).toBe(false);
  });

  it("does not call disposer for a different plugin's event", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    createPluginHostServiceCleanup(lifecycle, new Map([["plugin-A", dispose]]));

    lifecycle.emit("plugin.worker_stopped", { pluginId: "plugin-B" });

    expect(dispose).not.toHaveBeenCalled();
  });
});

// ============================================================================
// createPluginHostServiceCleanup — disposeAll
// ============================================================================

describe("createPluginHostServiceCleanup — disposeAll", () => {
  it("calls all registered disposers", () => {
    const d1 = vi.fn();
    const d2 = vi.fn();
    const disposers = new Map([
      ["plugin-1", d1],
      ["plugin-2", d2],
    ]);
    const { disposeAll } = createPluginHostServiceCleanup(makeLifecycle(), disposers);

    disposeAll();

    expect(d1).toHaveBeenCalledOnce();
    expect(d2).toHaveBeenCalledOnce();
  });

  it("clears the disposers map after calling all", () => {
    const disposers = new Map([
      ["plugin-1", vi.fn()],
      ["plugin-2", vi.fn()],
    ]);
    const { disposeAll } = createPluginHostServiceCleanup(makeLifecycle(), disposers);

    disposeAll();

    expect(disposers.size).toBe(0);
  });

  it("does not throw when disposers map is empty", () => {
    const { disposeAll } = createPluginHostServiceCleanup(makeLifecycle(), new Map());
    expect(() => disposeAll()).not.toThrow();
  });
});

// ============================================================================
// createPluginHostServiceCleanup — teardown
// ============================================================================

describe("createPluginHostServiceCleanup — teardown", () => {
  it("unregisters plugin.worker_stopped listener", () => {
    const lifecycle = makeLifecycle();
    const { teardown } = createPluginHostServiceCleanup(lifecycle, new Map());

    teardown();

    expect(lifecycle.off).toHaveBeenCalledWith("plugin.worker_stopped", expect.any(Function));
  });

  it("unregisters plugin.unloaded listener", () => {
    const lifecycle = makeLifecycle();
    const { teardown } = createPluginHostServiceCleanup(lifecycle, new Map());

    teardown();

    expect(lifecycle.off).toHaveBeenCalledWith("plugin.unloaded", expect.any(Function));
  });

  it("stops delivering events after teardown", () => {
    const lifecycle = makeLifecycle();
    const dispose = vi.fn();
    const { teardown } = createPluginHostServiceCleanup(
      lifecycle,
      new Map([["plugin-1", dispose]]),
    );

    teardown();
    lifecycle.emit("plugin.worker_stopped", { pluginId: "plugin-1" });

    expect(dispose).not.toHaveBeenCalled();
  });
});
