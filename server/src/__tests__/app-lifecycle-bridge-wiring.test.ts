import { describe, expect, it, vi } from "vitest";
import { createLifecycleEventPublisher } from "../services/plugin-lifecycle-event-bridge.js";

describe("createLifecycleEventPublisher (WS-3 app wiring)", () => {
  it("returns a LifecycleEventPublisher function", () => {
    const mockBus = {
      emit: vi.fn(async () => ({ errors: [] })),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    };
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    } as never;

    const publisher = createLifecycleEventPublisher(mockBus as never, mockDb);
    expect(typeof publisher).toBe("function");
  });

  it("two calls with same args return equivalent functions", () => {
    const mockBus = {
      emit: vi.fn(async () => ({ errors: [] })),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    };
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    } as never;

    const p1 = createLifecycleEventPublisher(mockBus as never, mockDb);
    const p2 = createLifecycleEventPublisher(mockBus as never, mockDb);
    expect(typeof p1).toBe(typeof p2);
  });

  it("calls bus.emit when publisher is invoked with a plugin record", async () => {
    const mockBus = {
      emit: vi.fn(async () => ({ errors: [] })),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    };
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([{ id: "company-123" }]),
      }),
    } as never;

    const publisher = createLifecycleEventPublisher(mockBus as never, mockDb);
    const record = {
      id: "plugin-id",
      pluginKey: "acme.test",
      packageName: "@acme/test",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "acme.test", name: "Test", version: "1.0.0", description: "", apiVersion: 1, capabilities: [] },
      status: "ready",
      installOrder: 1,
      packagePath: null,
      lastError: null,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as never;

    await publisher("plugin.installed", record);
    expect(mockBus.emit).toHaveBeenCalledOnce();
    expect(mockBus.emit.mock.calls[0][0].eventType).toBe("plugin.installed");
  });
});
