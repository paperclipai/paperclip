import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { createApp } from "../app.js";
import type { StorageService } from "../storage/types.js";

const { loadAllMock, schedulerStartMock, coordinatorStartMock, dispatcherInitializeMock } = vi.hoisted(() => ({
  loadAllMock: vi.fn().mockResolvedValue({ total: 0, succeeded: 0, failed: 0, results: [] }),
  schedulerStartMock: vi.fn(),
  coordinatorStartMock: vi.fn(),
  dispatcherInitializeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/plugin-loader.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-loader.js")>("../services/plugin-loader.js");
  return {
    ...actual,
    pluginLoader: vi.fn(() => ({
      loadAll: loadAllMock,
    })),
  };
});

vi.mock("../services/plugin-job-scheduler.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-job-scheduler.js")>(
    "../services/plugin-job-scheduler.js",
  );
  return {
    ...actual,
    createPluginJobScheduler: vi.fn(() => ({
      start: schedulerStartMock,
      stop: vi.fn(),
    })),
  };
});

vi.mock("../services/plugin-job-coordinator.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-job-coordinator.js")>(
    "../services/plugin-job-coordinator.js",
  );
  return {
    ...actual,
    createPluginJobCoordinator: vi.fn(() => ({
      start: coordinatorStartMock,
      stop: vi.fn(),
    })),
  };
});

vi.mock("../services/plugin-tool-dispatcher.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-tool-dispatcher.js")>(
    "../services/plugin-tool-dispatcher.js",
  );
  return {
    ...actual,
    createPluginToolDispatcher: vi.fn(() => ({
      initialize: dispatcherInitializeMock,
      listToolsForAgent: vi.fn(() => []),
      getTool: vi.fn(() => null),
      executeTool: vi.fn(),
    })),
  };
});

function createStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describe("GET /metrics", () => {
  it("returns Prometheus text with placeholder cap counters registered", async () => {
    const app = await createApp({} as Db, {
      uiMode: "none",
      serverPort: 0,
      storageService: createStorageService(),
      deploymentMode: "local_trusted",
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain;\s*version=0\.0\.4/);
    expect(res.text).toContain(
      "# HELP paperclip_placeholder_cap_hits_total Times the placeholder-comment cap blocked an agent comment post.",
    );
    expect(res.text).toContain("# TYPE paperclip_placeholder_cap_hits_total counter");
    expect(res.text).toContain(
      "# HELP paperclip_placeholder_cap_overrides_total Times a board override bypassed the placeholder-comment cap.",
    );
    expect(res.text).toContain("# TYPE paperclip_placeholder_cap_overrides_total counter");
  });
});
