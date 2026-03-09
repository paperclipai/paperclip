import { describe, expect, it, vi, beforeEach } from "vitest";
import { pluginLoader } from "../services/plugin-loader.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import * as fs from "node:fs";

vi.mock("../services/plugin-registry.js");
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

const dummyRuntimeServices = {
  workerManager: { isRunning: vi.fn().mockReturnValue(false), startWorker: vi.fn().mockResolvedValue(undefined) } as any,
  eventBus: { forPlugin: vi.fn().mockReturnValue({}), subscriptionCount: vi.fn().mockReturnValue(0) } as any,
  jobScheduler: { registerPlugin: vi.fn().mockResolvedValue(undefined) } as any,
  jobStore: { syncJobDeclarations: vi.fn().mockResolvedValue(undefined) } as any,
  toolDispatcher: { registerPluginTools: vi.fn() } as any,
  lifecycleManager: { markError: vi.fn().mockResolvedValue(undefined) } as any,
  instanceInfo: { instanceId: "test", hostVersion: "1.0.0" },
  buildHostHandlers: vi.fn().mockReturnValue({}),
};

describe("pluginLoader.loadAll parallelization", () => {
  const db = {} as any;
  const mockRegistry = {
    listByStatus: vi.fn(),
    getConfig: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (pluginRegistryService as any).mockReturnValue(mockRegistry);
    (fs.existsSync as any).mockReturnValue(true);
  });

  it("loads multiple plugins in parallel", async () => {
    const loader = pluginLoader(db, {}, dummyRuntimeServices);

    const plugins = [
      { id: "p1", pluginKey: "k1", packageName: "pk1", manifestJson: { id: "k1", entrypoints: { worker: "w.js" } }, version: "1.0.0" },
      { id: "p2", pluginKey: "k2", packageName: "pk2", manifestJson: { id: "k2", entrypoints: { worker: "w.js" } }, version: "1.0.0" },
    ];

    mockRegistry.listByStatus.mockResolvedValue(plugins);
    mockRegistry.getConfig.mockResolvedValue({});

    // Execute loadAll
    const result = await loader.loadAll();

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(dummyRuntimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);
  });

  it("returns early if no plugins found", async () => {
    const loader = pluginLoader(db, {}, dummyRuntimeServices);
    mockRegistry.listByStatus.mockResolvedValue([]);

    const result = await loader.loadAll();

    expect(result.total).toBe(0);
    expect(dummyRuntimeServices.workerManager.startWorker).not.toHaveBeenCalled();
  });
});
