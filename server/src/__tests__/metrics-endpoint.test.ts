import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { createApp } from "../app.js";
import { placeholderCapHits, placeholderCapOverrides } from "../observability/prom.js";
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

type CreateAppOptions = Parameters<typeof createApp>[1];

const ORIGINAL_METRICS_TOKEN = process.env.PAPERCLIP_METRICS_TOKEN;
const METRICS_TOKEN = "test-secret-token-32chars-min!";

function createMetricsAppOptions(overrides: Partial<CreateAppOptions> = {}): CreateAppOptions {
  return {
    uiMode: "none",
    serverPort: 0,
    storageService: createStorageService(),
    deploymentMode: "local_trusted",
    deploymentExposure: "public",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

function expectPrometheusCounters(text: string) {
  expect(text).toContain(
    "# HELP paperclip_placeholder_cap_hits_total Times the placeholder-comment cap blocked an agent comment post.",
  );
  expect(text).toContain("# TYPE paperclip_placeholder_cap_hits_total counter");
  expect(text).toContain(
    "# HELP paperclip_placeholder_cap_overrides_total Times a board override bypassed the placeholder-comment cap.",
  );
  expect(text).toContain("# TYPE paperclip_placeholder_cap_overrides_total counter");
  expect((placeholderCapHits as unknown as { labelNames: string[] }).labelNames).toEqual(["agent_id"]);
  expect((placeholderCapOverrides as unknown as { labelNames: string[] }).labelNames).toEqual(["agent_id"]);
}

describe("GET /metrics", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_METRICS_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL_METRICS_TOKEN === undefined) {
      delete process.env.PAPERCLIP_METRICS_TOKEN;
    } else {
      process.env.PAPERCLIP_METRICS_TOKEN = ORIGINAL_METRICS_TOKEN;
    }
  });

  it("returns Prometheus text with placeholder cap counters registered in private deployments", async () => {
    const app = await createApp(
      {} as Db,
      createMetricsAppOptions({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: ["127.0.0.1"],
        bindHost: "127.0.0.1",
      }),
    );

    const res = await request(app).get("/metrics").set("Host", "127.0.0.1");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain;\s*version=0\.0\.4/);
    expectPrometheusCounters(res.text);
  });

  it("does not mount metrics in public deployments without a metrics token", async () => {
    const app = await createApp({} as Db, createMetricsAppOptions());

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(404);
  });

  it("requires authorization in public deployments with a metrics token", async () => {
    process.env.PAPERCLIP_METRICS_TOKEN = METRICS_TOKEN;
    const app = await createApp({} as Db, createMetricsAppOptions());

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(401);
  });

  it("returns Prometheus text in public deployments with a matching bearer token", async () => {
    process.env.PAPERCLIP_METRICS_TOKEN = METRICS_TOKEN;
    const app = await createApp({} as Db, createMetricsAppOptions());

    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${METRICS_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain;\s*version=0\.0\.4/);
    expectPrometheusCounters(res.text);
  });

  it("rejects non-matching public metrics bearer tokens", async () => {
    process.env.PAPERCLIP_METRICS_TOKEN = METRICS_TOKEN;
    const app = await createApp({} as Db, createMetricsAppOptions());

    const res = await request(app).get("/metrics").set("Authorization", "Bearer wrong-token");

    expect(res.status).toBe(401);
  });
});
