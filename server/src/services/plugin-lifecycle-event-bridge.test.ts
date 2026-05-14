import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginRecord } from "@paperclipai/shared";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createLifecycleEventPublisher, type LifecycleEventPublisher } from "./plugin-lifecycle-event-bridge.js";

function makeManifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: "acme.test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    apiVersion: 1,
    capabilities: ["events.subscribe"],
    ...overrides,
  } as PaperclipPluginManifestV1;
}

function makePluginRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "plugin-id-123",
    pluginKey: "acme.test-plugin",
    packageName: "@acme/test-plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: makeManifest(),
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockBus() {
  const emittedEvents: PluginEvent[] = [];
  return {
    bus: {
      emit: vi.fn(async (event: PluginEvent) => {
        emittedEvents.push(event);
        return { errors: [] };
      }),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    },
    emittedEvents,
  };
}

function makeMockDb(companyIds: string[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue(companyIds.map((id) => ({ id }))),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

describe("createLifecycleEventPublisher (WS-3)", () => {
  let publisher: LifecycleEventPublisher;
  let mockBus: ReturnType<typeof makeMockBus>;
  let mockDb: ReturnType<typeof makeMockDb>;
  const record = makePluginRecord();

  beforeEach(() => {
    mockBus = makeMockBus();
    mockDb = makeMockDb(["company-a", "company-b", "company-c"]);
    publisher = createLifecycleEventPublisher(mockBus.bus as never, mockDb);
  });

  it("fans out plugin.installed to each company", async () => {
    await publisher("plugin.installed", record);
    expect(mockBus.bus.emit).toHaveBeenCalledTimes(3);
    for (const call of mockBus.bus.emit.mock.calls) {
      expect(call[0].eventType).toBe("plugin.installed");
    }
  });

  it("fans out plugin.uninstalled to each company", async () => {
    await publisher("plugin.uninstalled", record);
    expect(mockBus.bus.emit).toHaveBeenCalledTimes(3);
    for (const call of mockBus.bus.emit.mock.calls) {
      expect(call[0].eventType).toBe("plugin.uninstalled");
    }
  });

  it("fans out plugin.enabled to each company", async () => {
    await publisher("plugin.enabled", record);
    expect(mockBus.bus.emit).toHaveBeenCalledTimes(3);
  });

  it("fans out plugin.disabled to each company", async () => {
    await publisher("plugin.disabled", record);
    expect(mockBus.bus.emit).toHaveBeenCalledTimes(3);
  });

  it("emits one event per company with correct companyId", async () => {
    await publisher("plugin.installed", record);
    const companyIds = mockBus.bus.emit.mock.calls.map((c) => c[0].companyId);
    expect(companyIds.sort()).toEqual(["company-a", "company-b", "company-c"]);
  });

  it("payload includes pluginId, pluginKey, and manifest", async () => {
    await publisher("plugin.installed", record);
    const firstEmit = mockBus.bus.emit.mock.calls[0][0];
    expect(firstEmit.payload).toMatchObject({
      pluginId: record.id,
      pluginKey: record.pluginKey,
      manifest: record.manifestJson,
    });
  });

  it("emits zero bus calls when there are no companies", async () => {
    const emptyDb = makeMockDb([]);
    const emptyPublisher = createLifecycleEventPublisher(mockBus.bus as never, emptyDb);
    await emptyPublisher("plugin.installed", record);
    expect(mockBus.bus.emit).not.toHaveBeenCalled();
  });

  it("does not throw when DB company query fails", async () => {
    const failingDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockRejectedValue(new Error("DB connection error")),
      }),
    } as unknown as import("@paperclipai/db").Db;
    const failingPublisher = createLifecycleEventPublisher(mockBus.bus as never, failingDb);
    await expect(failingPublisher("plugin.installed", record)).resolves.not.toThrow();
    expect(mockBus.bus.emit).not.toHaveBeenCalled();
  });

  it("entityType is plugin", async () => {
    await publisher("plugin.installed", record);
    const firstEmit = mockBus.bus.emit.mock.calls[0][0];
    expect(firstEmit.entityType).toBe("plugin");
    expect(firstEmit.entityId).toBe(record.id);
  });

  it("actorType is system", async () => {
    await publisher("plugin.installed", record);
    const firstEmit = mockBus.bus.emit.mock.calls[0][0];
    expect(firstEmit.actorType).toBe("system");
  });

  it("does not throw when one company bus.emit rejects; other companies still receive event (F4)", async () => {
    let callCount = 0;
    const partialFailBus = {
      emit: vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) throw new Error("bus.emit failed for company-b");
        return { errors: [] };
      }),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    };
    const threeCompanyDb = makeMockDb(["company-a", "company-b", "company-c"]);
    const partialPublisher = createLifecycleEventPublisher(partialFailBus as never, threeCompanyDb);

    await expect(partialPublisher("plugin.installed", record)).resolves.not.toThrow();
    expect(partialFailBus.emit).toHaveBeenCalledTimes(3);
  });

  it("does not throw when bus.emit returns non-empty errors array (handler errors logged, not thrown)", async () => {
    const errorBus = {
      emit: vi.fn(async () => ({
        errors: [{ pluginId: "other-plugin", error: new Error("handler crashed") }],
      })),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    };
    const singleCompanyDb = makeMockDb(["company-x"]);
    const errorPublisher = createLifecycleEventPublisher(errorBus as never, singleCompanyDb);

    await expect(errorPublisher("plugin.installed", record)).resolves.not.toThrow();
    expect(errorBus.emit).toHaveBeenCalledOnce();
  });
});
