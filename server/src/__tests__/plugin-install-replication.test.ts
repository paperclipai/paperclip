/**
 * Route-level tests for plugin artifact replication hooks on the plugin
 * mutation routes (install / uninstall / upgrade).
 *
 * In multi-replica deployments a runtime plugin install mutates the local
 * plugin tree on ONE replica only. The routes must therefore:
 *
 * 1. Serialize the mutation cluster-wide via the "plugin-install" advisory
 *    lock and publish a tree snapshot INSIDE that lock, after the disk +
 *    registry mutation succeeded and BEFORE the success response / live event.
 * 2. Reject local-path installs while replication is active (a local path
 *    references one replica's filesystem and cannot be replicated).
 * 3. Fail the request loudly (500, no `plugin.ui.updated` event) when the
 *    snapshot publish fails — better a loud failure than replicas silently
 *    diverging from the local mutation.
 *
 * Mirrors the supertest + mocked-services harness of
 * `plugin-webhook-dedup.test.ts`.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

const mockWithAdvisoryXactLock = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _name: string, fn: () => Promise<unknown>) => fn()),
);

const mockPublishGlobalLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: mockPublishGlobalLiveEvent,
}));

vi.mock("../services/advisory-locks.js", () => ({
  withAdvisoryXactLock: mockWithAdvisoryXactLock,
}));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";

const pluginRow = {
  id: PLUGIN_ID,
  pluginKey: "acme.test",
  packageName: "@acme/plugin-test",
  version: "1.0.0",
  status: "ready",
};

function createReplication(overrides: Partial<{
  isActive: () => boolean;
  publishSnapshot: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isActive: overrides.isActive ?? (() => true),
    publishSnapshot: overrides.publishSnapshot ?? vi.fn().mockResolvedValue({ generation: 1 }),
  };
}

async function createApp(replication?: ReturnType<typeof createReplication>) {
  const { pluginRoutes } = await import("../routes/plugins.js");
  const { errorHandler } = await import("../middleware/index.js");

  const loader = {
    installPlugin: vi.fn().mockResolvedValue({ manifest: { id: pluginRow.pluginKey } }),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    };
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      loader as never,
      undefined,
      undefined,
      undefined,
      undefined,
      replication ? ({ replication } as never) : undefined,
    ),
  );
  app.use(errorHandler);

  return { app, loader };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithAdvisoryXactLock.mockImplementation(
    async (_db: unknown, _name: string, fn: () => Promise<unknown>) => fn(),
  );
  mockRegistry.getById.mockResolvedValue(pluginRow);
  mockRegistry.getByKey.mockResolvedValue(pluginRow);
  mockLifecycle.load.mockResolvedValue(pluginRow);
  mockLifecycle.unload.mockResolvedValue(pluginRow);
  mockLifecycle.upgrade.mockResolvedValue({ ...pluginRow, version: "1.1.0" });
});

describe("POST /api/plugins/install (replication)", () => {
  it("publishes a snapshot exactly once, inside the plugin-install advisory lock", async () => {
    let insideLock = false;
    let publishedInsideLock = false;
    mockWithAdvisoryXactLock.mockImplementation(
      async (_db: unknown, _name: string, fn: () => Promise<unknown>) => {
        insideLock = true;
        try {
          return await fn();
        } finally {
          insideLock = false;
        }
      },
    );
    const replication = createReplication({
      publishSnapshot: vi.fn(async () => {
        publishedInsideLock = insideLock;
        return { generation: 7 };
      }),
    });
    const { app, loader } = await createApp(replication);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "@acme/plugin-test" });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({
      packageName: "@acme/plugin-test",
      version: undefined,
    });
    expect(mockWithAdvisoryXactLock).toHaveBeenCalledTimes(1);
    expect(mockWithAdvisoryXactLock.mock.calls[0]?.[1]).toBe("plugin-install");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(publishedInsideLock).toBe(true);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "installed" },
    });
  });

  it("rejects local-path installs with 400 while replication is active", async () => {
    const replication = createReplication();
    const { app, loader } = await createApp(replication);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "/tmp/my-plugin", isLocalPath: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not replicable across replicas/);
    expect(loader.installPlugin).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
  });

  it("passes local-path installs through when replication is disabled", async () => {
    const replication = createReplication({ isActive: () => false });
    const { app, loader } = await createApp(replication);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "/tmp/my-plugin", isLocalPath: true });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({ localPath: "/tmp/my-plugin" });
    // Disabled replication: no cluster lock, no snapshot publish.
    expect(mockWithAdvisoryXactLock).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
  });

  it("passes local-path installs through when no replication deps are wired", async () => {
    const { app, loader } = await createApp(undefined);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "/tmp/my-plugin", isLocalPath: true });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({ localPath: "/tmp/my-plugin" });
    expect(mockWithAdvisoryXactLock).not.toHaveBeenCalled();
  });

  it("returns 500 and emits no live event when publishSnapshot rejects", async () => {
    const replication = createReplication({
      publishSnapshot: vi.fn().mockRejectedValue(new Error("s3 unreachable")),
    });
    const { app } = await createApp(replication);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "@acme/plugin-test" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/snapshot replication failed/);
    expect(res.body.error).toMatch(/s3 unreachable/);
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/plugins/:pluginId (replication)", () => {
  it("publishes a snapshot exactly once inside the advisory lock on uninstall", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(200);
    expect(mockLifecycle.unload).toHaveBeenCalledWith(PLUGIN_ID, false);
    expect(mockWithAdvisoryXactLock).toHaveBeenCalledTimes(1);
    expect(mockWithAdvisoryXactLock.mock.calls[0]?.[1]).toBe("plugin-install");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and emits no live event when publishSnapshot rejects", async () => {
    const replication = createReplication({
      publishSnapshot: vi.fn().mockRejectedValue(new Error("s3 unreachable")),
    });
    const { app } = await createApp(replication);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/snapshot replication failed/);
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/plugins/:pluginId/upgrade (replication)", () => {
  it("publishes a snapshot exactly once inside the advisory lock on upgrade", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    expect(mockWithAdvisoryXactLock).toHaveBeenCalledTimes(1);
    expect(mockWithAdvisoryXactLock.mock.calls[0]?.[1]).toBe("plugin-install");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and emits no live event when publishSnapshot rejects", async () => {
    const replication = createReplication({
      publishSnapshot: vi.fn().mockRejectedValue(new Error("s3 unreachable")),
    });
    const { app } = await createApp(replication);

    const res = await request(app).post(`/api/plugins/${PLUGIN_ID}/upgrade`).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/snapshot replication failed/);
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  });

  it("does not lock or publish when replication is disabled", async () => {
    const replication = createReplication({ isActive: () => false });
    const { app } = await createApp(replication);

    const res = await request(app).post(`/api/plugins/${PLUGIN_ID}/upgrade`).send({});

    expect(res.status).toBe(200);
    expect(mockWithAdvisoryXactLock).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
  });
});
