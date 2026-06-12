/**
 * Route-level tests for plugin artifact replication hooks on the plugin
 * mutation routes (install / uninstall / upgrade).
 *
 * In multi-replica deployments a runtime plugin install mutates the local
 * plugin tree on ONE replica only. The routes must therefore:
 *
 * 1. Serialize the mutation cluster-wide via the session-scoped
 *    "plugin-install" advisory lock (a SESSION lock on a dedicated direct
 *    connection — the critical section spans an npm install plus tar+upload,
 *    far too long for a pooled transaction lock). Contention → 409.
 * 2. Converge the local tree onto max(generation) FIRST (reconcile), then
 *    run the mutation, then publish — all inside `runExclusive`, so a stale
 *    replica's install can never drop a peer's newer install and no
 *    reconcile pass can swap the tree mid-mutation.
 * 3. Reject local-path installs while replication is active (a local path
 *    references one replica's filesystem and cannot be replicated).
 * 4. Fail the request loudly (500, no `plugin.ui.updated` event) when the
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

/**
 * Stateful fake of `trySessionAdvisoryLock`: behaves like the real session
 * lock (first acquirer wins, contenders get `{ acquired: false }` until
 * release), so tests can hold the lock via a second call to the same fake.
 */
const heldSessionLocks = vi.hoisted(() => new Set<string>());
const mockTrySessionAdvisoryLock = vi.hoisted(() =>
  vi.fn(async (_connectionString: string, name: string) => {
    if (heldSessionLocks.has(name)) return { acquired: false as const };
    heldSessionLocks.add(name);
    return {
      acquired: true as const,
      release: vi.fn(async () => {
        heldSessionLocks.delete(name);
      }),
    };
  }),
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
  trySessionAdvisoryLock: mockTrySessionAdvisoryLock,
  withAdvisoryXactLock: vi.fn(async (_db: unknown, _name: string, fn: () => Promise<unknown>) => fn()),
  tryAdvisoryXactLock: vi.fn(),
}));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const LOCK_URL = "postgres://lock-url/test";

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
  reconcile: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isActive: overrides.isActive ?? (() => true),
    publishSnapshot: overrides.publishSnapshot ?? vi.fn().mockResolvedValue({ generation: 1 }),
    reconcile: overrides.reconcile ?? vi.fn().mockResolvedValue({ applied: false, generation: 1 }),
    runExclusive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
      replication
        ? ({ replication, pluginMutationLockUrl: LOCK_URL } as never)
        : undefined,
    ),
  );
  app.use(errorHandler);

  return { app, loader };
}

beforeEach(() => {
  vi.clearAllMocks();
  heldSessionLocks.clear();
  mockRegistry.getById.mockResolvedValue(pluginRow);
  mockRegistry.getByKey.mockResolvedValue(pluginRow);
  mockLifecycle.load.mockResolvedValue(pluginRow);
  mockLifecycle.unload.mockResolvedValue(pluginRow);
  mockLifecycle.upgrade.mockResolvedValue({ ...pluginRow, version: "1.1.0" });
});

describe("POST /api/plugins/install (replication)", () => {
  it("converges first, then installs, then publishes — all inside the session lock", async () => {
    let publishedWhileLockHeld = false;
    const replication = createReplication({
      publishSnapshot: vi.fn(async () => {
        publishedWhileLockHeld = heldSessionLocks.has("plugin-install");
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
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledWith(LOCK_URL, "plugin-install");
    expect(replication.runExclusive).toHaveBeenCalledTimes(1);
    expect(replication.reconcile).toHaveBeenCalledTimes(1);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(publishedWhileLockHeld).toBe(true);
    // Converge-before-mutate ordering: reconcile → install fn → publish.
    const reconcileOrder = replication.reconcile.mock.invocationCallOrder[0]!;
    const installOrder = loader.installPlugin.mock.invocationCallOrder[0]!;
    const publishOrder = replication.publishSnapshot.mock.invocationCallOrder[0]!;
    expect(reconcileOrder).toBeLessThan(installOrder);
    expect(installOrder).toBeLessThan(publishOrder);
    // The session lock is released after the request.
    expect(heldSessionLocks.size).toBe(0);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "installed" },
    });
  });

  it("returns 409 when the plugin-install session lock is held elsewhere", async () => {
    const replication = createReplication();
    const { app, loader } = await createApp(replication);

    // Hold the lock via a second trySessionAdvisoryLock, as a concurrent
    // mutation (this or another replica) would.
    const held = await mockTrySessionAdvisoryLock(LOCK_URL, "plugin-install");
    expect(held.acquired).toBe(true);
    try {
      const res = await request(app)
        .post("/api/plugins/install")
        .send({ packageName: "@acme/plugin-test" });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "another plugin operation is in progress on this instance",
      });
      expect(loader.installPlugin).not.toHaveBeenCalled();
      expect(replication.reconcile).not.toHaveBeenCalled();
      expect(replication.publishSnapshot).not.toHaveBeenCalled();
      expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
    } finally {
      if (held.acquired) await held.release();
    }
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
    // Disabled replication: no cluster lock, no reconcile, no snapshot publish.
    expect(mockTrySessionAdvisoryLock).not.toHaveBeenCalled();
    expect(replication.reconcile).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
  });

  it("passes local-path installs through when no replication deps are wired", async () => {
    const { app, loader } = await createApp(undefined);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "/tmp/my-plugin", isLocalPath: true });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({ localPath: "/tmp/my-plugin" });
    expect(mockTrySessionAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 500, emits no live event, and releases the lock when publishSnapshot rejects", async () => {
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
    // The session lock must not leak on the failure path.
    expect(heldSessionLocks.size).toBe(0);
  });
});

describe("DELETE /api/plugins/:pluginId (replication)", () => {
  it("reconciles and publishes exactly once inside the session lock on uninstall", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(200);
    expect(mockLifecycle.unload).toHaveBeenCalledWith(PLUGIN_ID, false);
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledWith(LOCK_URL, "plugin-install");
    expect(replication.reconcile).toHaveBeenCalledTimes(1);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(heldSessionLocks.size).toBe(0);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the plugin-install session lock is held elsewhere", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const held = await mockTrySessionAdvisoryLock(LOCK_URL, "plugin-install");
    expect(held.acquired).toBe(true);
    try {
      const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "another plugin operation is in progress on this instance",
      });
      expect(mockLifecycle.unload).not.toHaveBeenCalled();
      expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
    } finally {
      if (held.acquired) await held.release();
    }
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
    expect(heldSessionLocks.size).toBe(0);
  });
});

describe("POST /api/plugins/:pluginId/upgrade (replication)", () => {
  it("reconciles and publishes exactly once inside the session lock on upgrade", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledWith(LOCK_URL, "plugin-install");
    expect(replication.reconcile).toHaveBeenCalledTimes(1);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(heldSessionLocks.size).toBe(0);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the plugin-install session lock is held elsewhere", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const held = await mockTrySessionAdvisoryLock(LOCK_URL, "plugin-install");
    expect(held.acquired).toBe(true);
    try {
      const res = await request(app).post(`/api/plugins/${PLUGIN_ID}/upgrade`).send({});

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "another plugin operation is in progress on this instance",
      });
      expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
      expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
    } finally {
      if (held.acquired) await held.release();
    }
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
    expect(heldSessionLocks.size).toBe(0);
  });

  it("does not lock or publish when replication is disabled", async () => {
    const replication = createReplication({ isActive: () => false });
    const { app } = await createApp(replication);

    const res = await request(app).post(`/api/plugins/${PLUGIN_ID}/upgrade`).send({});

    expect(res.status).toBe(200);
    expect(mockTrySessionAdvisoryLock).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
  });
});
