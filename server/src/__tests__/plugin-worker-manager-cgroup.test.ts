/**
 * Cgroup-specific unit tests for createPluginWorkerHandle.
 *
 * Coverage note: the generation-counter skip path (cgroupGeneration !== teardownGeneration)
 * in handleProcessExit requires a real child process exit to trigger. That path is
 * exercised by Tier 2 integration tests; the unit-level coverage here validates initial
 * state and the cgroupEnforced/cgroupError diagnostics surface only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PluginCgroupManager } from "../services/plugin-cgroup-manager.js";

function makeMockCgroupManager(overrides: Partial<PluginCgroupManager> = {}): PluginCgroupManager {
  return {
    isSupported: vi.fn().mockResolvedValue(true),
    setup: vi.fn().mockResolvedValue(undefined),
    enterCgroup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    checkOomKill: vi.fn().mockResolvedValue(false),
    cgroupPath: vi.fn().mockReturnValue("/mock/cgroup/path"),
    effectiveLimits: vi.fn().mockReturnValue({ pidsMax: 64 }),
    ...overrides,
  };
}

describe("createPluginWorkerHandle — cgroup integration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("WorkerDiagnostics includes cgroupEnforced=false when no manager provided", async () => {
    const { createPluginWorkerHandle } = await import("../services/plugin-worker-manager.js");
    const handle = createPluginWorkerHandle("acme.test", {
      entrypointPath: "/nonexistent/worker.cjs",
      manifest: { id: "acme.test", apiVersion: 1, version: "1.0.0", displayName: "Test",
        description: "Test", author: "Test", categories: [], capabilities: [],
        entrypoints: { worker: "worker.cjs" } },
      config: {},
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });
    const diag = handle.diagnostics();
    expect(diag.cgroupEnforced).toBe(false);
    expect(diag.cgroupError).toBeUndefined();
  });

  it("WorkerDiagnostics includes cgroupEnforced=false when manager is provided but not entered yet", async () => {
    const { createPluginWorkerHandle } = await import("../services/plugin-worker-manager.js");
    const cgroupManager = makeMockCgroupManager();
    const handle = createPluginWorkerHandle("acme.test", {
      entrypointPath: "/nonexistent/worker.cjs",
      manifest: { id: "acme.test", apiVersion: 1, version: "1.0.0", displayName: "Test",
        description: "Test", author: "Test", categories: [], capabilities: [],
        entrypoints: { worker: "worker.cjs" } },
      config: {},
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      cgroupManager,
      cgroupLimits: { pidsMax: 64 },
    });
    const diag = handle.diagnostics();
    expect(diag.cgroupEnforced).toBe(false);
    expect(typeof diag.cgroupError).toBe("undefined");
  });
});
