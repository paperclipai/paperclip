import { describe, expect, it, vi, beforeEach } from "vitest";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

const mockRegistry = {
  getById: vi.fn(),
  updateStatus: vi.fn(),
};

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("pluginLifecycleManager load -> loader.loadSingle", () => {
  const db = {} as any;

  function makeLoadResult(pluginId: string, status: "ready" | "error" = "ready") {
    return {
      plugin: {
        id: pluginId,
        pluginKey: "test-plugin",
        status,
      },
      success: status === "ready",
      error: status === "ready" ? undefined : "worker failed",
      registered: {
        worker: status === "ready",
        eventSubscriptions: 0,
        jobs: 0,
        webhooks: 0,
        tools: 0,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls loader.loadSingle when lifecycle.load is called", async () => {
    const mockLoader = {
      loadSingle: vi.fn().mockResolvedValue(makeLoadResult("p1")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
    };

    const lifecycle = pluginLifecycleManager(db, { loader: mockLoader as any });

    const pluginId = "p1";
    // Mock getById to return an installed plugin
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "installed",
      pluginKey: "test-plugin",
      manifestJson: { id: "test" },
    });
    // Mock updateStatus to return a ready plugin
    mockRegistry.updateStatus.mockResolvedValue({ id: pluginId, status: "ready", pluginKey: "test-plugin" });

    await lifecycle.load(pluginId);

    expect(mockRegistry.updateStatus).toHaveBeenCalledWith(pluginId, expect.objectContaining({ status: "ready" }));
    expect(mockLoader.loadSingle).toHaveBeenCalledWith(pluginId);
  });

  it("calls loader.loadSingle when lifecycle.enable is called", async () => {
    const mockLoader = {
      loadSingle: vi.fn().mockResolvedValue(makeLoadResult("p3")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      upgradePlugin: vi.fn(),
    };

    const lifecycle = pluginLifecycleManager(db, { loader: mockLoader as any });

    const pluginId = "p3";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "error",
      pluginKey: "test-plugin",
      manifestJson: { id: "test", version: "1.0.0", capabilities: [] },
      version: "1.0.0",
    });
    mockRegistry.updateStatus.mockResolvedValue({ id: pluginId, status: "ready", pluginKey: "test-plugin" });

    await lifecycle.enable(pluginId);

    expect(mockLoader.loadSingle).toHaveBeenCalledWith(pluginId);
  });

  it("calls loader.loadSingle when upgrade returns directly to ready", async () => {
    const mockLoader = {
      loadSingle: vi.fn().mockResolvedValue(makeLoadResult("p4")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      upgradePlugin: vi.fn().mockResolvedValue({
        oldManifest: {
          id: "test",
          version: "1.0.0",
          capabilities: ["issues.read"],
        },
        newManifest: {
          id: "test",
          version: "1.1.0",
          capabilities: ["issues.read"],
        },
        discovered: { version: "1.1.0" },
      }),
    };

    const lifecycle = pluginLifecycleManager(db, { loader: mockLoader as any });

    const pluginId = "p4";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "ready",
      pluginKey: "test-plugin",
      manifestJson: { id: "test", version: "1.0.0", capabilities: ["issues.read"] },
      version: "1.0.0",
    });
    mockRegistry.updateStatus.mockResolvedValue({ id: pluginId, status: "ready", pluginKey: "test-plugin" });

    await lifecycle.upgrade(pluginId, "1.1.0");

    expect(mockLoader.loadSingle).toHaveBeenCalledWith(pluginId);
  });

  it("surfaces activation failures from loader.loadSingle", async () => {
    const mockLoader = {
      loadSingle: vi.fn().mockResolvedValue(makeLoadResult("p5", "error")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
    };

    const lifecycle = pluginLifecycleManager(db, { loader: mockLoader as any });

    const pluginId = "p5";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "installed",
      pluginKey: "test-plugin",
      manifestJson: { id: "test" },
    });
    mockRegistry.updateStatus.mockResolvedValue({ id: pluginId, status: "ready", pluginKey: "test-plugin" });

    await expect(lifecycle.load(pluginId)).rejects.toThrow("worker failed");
  });

  it("does not throw if loader is not provided", async () => {
    const lifecycle = pluginLifecycleManager(db);

    const pluginId = "p2";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "installed",
      pluginKey: "test-plugin",
      manifestJson: { id: "test" },
    });
    mockRegistry.updateStatus.mockResolvedValue({ id: pluginId, status: "ready", pluginKey: "test-plugin" });

    await expect(lifecycle.load(pluginId)).resolves.toBeDefined();
  });
});
