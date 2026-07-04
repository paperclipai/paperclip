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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
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

/** Temp plugin trees created by createApp, removed after the suite. */
const tmpPluginDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpPluginDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Seed an installed package into a fake on-disk plugin tree. The publish-heal
 * branches gate on this DISK state (not only the registry row) because an
 * intervening peer generation can revert the tree while the shared-DB row
 * still claims the mutation happened.
 */
function seedInstalledPackage(pluginDir: string, packageName: string, version: string): void {
  const dir = path.join(pluginDir, "node_modules", ...packageName.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: packageName, version }));
}

async function createApp(replication?: ReturnType<typeof createReplication>) {
  const { pluginRoutes } = await import("../routes/plugins.js");
  const { errorHandler } = await import("../middleware/index.js");

  const pluginDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-route-test-"));
  tmpPluginDirs.push(pluginDir);
  const loader = {
    installPlugin: vi.fn().mockResolvedValue({ manifest: { id: pluginRow.pluginKey } }),
    getLocalPluginDir: vi.fn(() => pluginDir),
    cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined),
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

  return { app, loader, pluginDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  heldSessionLocks.clear();
  mockRegistry.getById.mockResolvedValue(pluginRow);
  mockRegistry.getByKey.mockResolvedValue(pluginRow);
  mockRegistry.listInstalled.mockResolvedValue([]);
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
  it("heals a failed publish on retry: already-installed same package republishes, emits the live event, and returns 200", async () => {
    const replication = createReplication();
    const { app, loader, pluginDir } = await createApp(replication);
    const { HttpError } = await import("../errors.js");
    loader.installPlugin.mockRejectedValue(new HttpError(409, "Plugin already installed: acme.test"));
    mockRegistry.listInstalled.mockResolvedValue([pluginRow]);
    mockRegistry.getById.mockResolvedValue(pluginRow);
    // The prior install's files survived the reconcile — pure republish heal.
    seedInstalledPackage(pluginDir, "@acme/plugin-test", "1.0.0");

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "@acme/plugin-test" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PLUGIN_ID);
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    // The original request 500'd before emitting, so the healed retry is the
    // install's only success response — it must fire the fast reconcile
    // trigger too, not leave peers to the periodic safety tick.
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "installed" },
    });
  });

  it("repairs an install retry when an intervening peer generation dropped the files: re-fetches instead of blind-healing", async () => {
    const replication = createReplication();
    const { app, loader } = await createApp(replication);
    const { HttpError } = await import("../errors.js");
    loader.installPlugin.mockRejectedValue(new HttpError(409, "Plugin already installed: acme.test"));
    mockRegistry.listInstalled.mockResolvedValue([pluginRow]);
    // A peer published between the failed install and this retry, so the
    // reconcile swapped in a tree WITHOUT this plugin's files — the registry
    // row says installed but the disk (deliberately not seeded) disagrees.
    // Blind-healing would publish a snapshot missing the files under a row
    // that claims them; the route must repair via lifecycle.upgrade instead.
    const repairedRow = { ...pluginRow, version: "1.0.0" };
    mockLifecycle.upgrade.mockResolvedValue(repairedRow);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "@acme/plugin-test" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PLUGIN_ID);
    // The repair must pin the version the registry row advertises ("1.0.0"),
    // not pass the caller's unpinned spec through — that would fetch npm's
    // CURRENT latest and spread an unintended upgrade cluster-wide.
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.0.0");
    // Repair happens inside the wrapper: reconcile → repair → publish.
    const upgradeOrder = mockLifecycle.upgrade.mock.invocationCallOrder[0]!;
    const publishOrder = replication.publishSnapshot.mock.invocationCallOrder[0]!;
    expect(upgradeOrder).toBeLessThan(publishOrder);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "installed" },
    });
  });

  it("does not heal when the conflicting package differs: conflict propagates as an error", async () => {
    const replication = createReplication();
    const { app, loader } = await createApp(replication);
    const { HttpError } = await import("../errors.js");
    loader.installPlugin.mockRejectedValue(new HttpError(409, "Plugin already installed: other.plugin"));
    mockRegistry.listInstalled.mockResolvedValue([
      { id: PLUGIN_ID, pluginKey: "other.plugin", packageName: "@other/package", status: "ready" },
    ]);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "@acme/plugin-test" });

    // Pre-existing install-route behavior: non-lock errors surface as 400.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already installed");
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
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

  it("heals a failed publish on soft-uninstall retry: already-uninstalled row republishes, emits the live event, and returns 200", async () => {
    const replication = createReplication();
    const { app, loader } = await createApp(replication);
    const { badRequest } = await import("../errors.js");
    const uninstalledRow = { ...pluginRow, status: "uninstalled" };
    // The prior uninstall soft-deleted the row but its publish failed; the
    // retry's unload rejects the already-uninstalled row before the wrapper
    // can publish.
    mockRegistry.getById.mockResolvedValue(uninstalledRow);
    mockLifecycle.unload.mockRejectedValue(
      badRequest("Plugin acme.test is already uninstalled. Use removeData=true to permanently delete it."),
    );

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PLUGIN_ID);
    expect(res.body.status).toBe("uninstalled");
    // An intervening peer generation can have reinstated the plugin's files
    // via the reconcile — the heal must re-run the artifact cleanup
    // (idempotent when the files are already gone) BEFORE the publish makes
    // this tree authoritative, or the republish would spread the files.
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledTimes(1);
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledWith(uninstalledRow);
    const cleanupOrder = loader.cleanupInstallArtifacts.mock.invocationCallOrder[0]!;
    const publishOrder = replication.publishSnapshot.mock.invocationCallOrder[0]!;
    expect(cleanupOrder).toBeLessThan(publishOrder);
    // The heal's whole point: the wrapper still publishes on the way out so
    // a generation row finally records the uninstall for peers.
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    // The original request 500'd before emitting, so the healed retry is the
    // uninstall's only success response — it must fire the fast reconcile
    // trigger too.
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "uninstalled" },
    });
  });

  it("does not heal when the row is not uninstalled: the unload error propagates without a publish", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);
    mockLifecycle.unload.mockRejectedValue(new Error("worker shutdown failed"));

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("worker shutdown failed");
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  });

  it("heals a failed publish on purge retry: missing row with purge=true republishes and returns 200/null", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);
    // The prior purge hard-deleted the row but its publish failed; the retry
    // resolves no plugin at all.
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}?purge=true`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
    // Lock → reconcile (no-op) → publish, same discipline as a real mutation.
    expect(mockTrySessionAdvisoryLock).toHaveBeenCalledWith(LOCK_URL, "plugin-install");
    expect(replication.reconcile).toHaveBeenCalledTimes(1);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(heldSessionLocks.size).toBe(0);
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "uninstalled" },
    });
  });

  it("purge heal sweeps plugin packages reinstated by an intervening peer generation before publishing", async () => {
    const replication = createReplication();
    const { app, loader, pluginDir } = await createApp(replication);
    // The prior purge hard-deleted the row, so no identifier maps to the
    // package anymore.
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    // A peer published between the failed purge and this retry: the
    // reconcile reinstated the purged plugin's files. The managed tree's
    // package.json records every plugin the loader ever `--save`d; only
    // "@other/live-plugin" still has a live registry row.
    // "../evil-escape" is a forged row-less entry with traversal segments —
    // the sweep must skip it (fail closed) rather than hand it to
    // cleanupInstallArtifacts.
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "paperclip-managed-plugins",
        dependencies: {
          "@acme/plugin-test": "^1.0.0",
          "@other/live-plugin": "^2.0.0",
          "../evil-escape": "^1.0.0",
        },
      }),
    );
    mockRegistry.listInstalled.mockResolvedValue([
      { id: "22222222-2222-4222-8222-222222222222", pluginKey: "other.live", packageName: "@other/live-plugin", version: "2.0.0", status: "ready" },
    ]);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}?purge=true`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    // Exactly the orphan is swept — the live plugin's files are untouched.
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledTimes(1);
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@acme/plugin-test" }),
    );
    // The sweep must land before the publish makes this tree authoritative.
    const cleanupOrder = loader.cleanupInstallArtifacts.mock.invocationCallOrder[0]!;
    const publishOrder = replication.publishSnapshot.mock.invocationCallOrder[0]!;
    expect(cleanupOrder).toBeLessThan(publishOrder);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a missing plugin without purge (no lock, no publish)", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}`);

    expect(res.status).toBe(404);
    expect(mockTrySessionAdvisoryLock).not.toHaveBeenCalled();
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing plugin with purge when replication is inactive", async () => {
    const replication = createReplication({ isActive: () => false });
    const { app } = await createApp(replication);
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);

    const res = await request(app).delete(`/api/plugins/${PLUGIN_ID}?purge=true`);

    expect(res.status).toBe(404);
    expect(replication.publishSnapshot).not.toHaveBeenCalled();
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

  it("heals a failed publish on upgrade retry: row already at the target version republishes without re-running the upgrade, emits the live event, and returns 200", async () => {
    const publishSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("s3 unreachable"))
      .mockResolvedValue({ generation: 2 });
    const replication = createReplication({ publishSnapshot });
    const { app, pluginDir } = await createApp(replication);

    // Attempt 1: the upgrade applies locally but the publish fails → 500.
    const first = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });
    expect(first.status).toBe(500);
    expect(first.body.error).toMatch(/snapshot replication failed/);
    expect(mockLifecycle.upgrade).toHaveBeenCalledTimes(1);
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();

    // The local mutation stuck: registry row AND disk are at the target
    // version (no peer generation intervened, so the reconcile no-ops).
    mockRegistry.getById.mockResolvedValue({ ...pluginRow, version: "1.1.0" });
    seedInstalledPackage(pluginDir, "@acme/plugin-test", "1.1.0");

    // Attempt 2 (the retry the 500 asked for): the heal skips the local
    // mutation — no second npm download — and the wrapper republishes,
    // which is exactly the missing half.
    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("1.1.0");
    expect(mockLifecycle.upgrade).toHaveBeenCalledTimes(1); // not re-run
    expect(publishSnapshot).toHaveBeenCalledTimes(2);
    // The original request 500'd before emitting, so the healed retry is the
    // upgrade's only success response — it must fire the fast reconcile
    // trigger too.
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith({
      type: "plugin.ui.updated",
      payload: { pluginId: PLUGIN_ID, action: "upgraded" },
    });
  });

  it("does not heal an upgrade retry when an intervening peer generation reverted the disk: lifecycle.upgrade repairs the tree", async () => {
    const replication = createReplication();
    const { app, pluginDir } = await createApp(replication);
    // A peer published between the failed upgrade and this retry: the
    // reconcile swapped in a snapshot built from a PRE-upgrade tree, so the
    // disk is back at 1.0.0 while the shared registry row still says 1.1.0.
    // Blind-healing here would publish 1.0.0 files under a row claiming
    // 1.1.0 and spread the mismatch cluster-wide.
    mockRegistry.getById.mockResolvedValue({ ...pluginRow, version: "1.1.0" });
    seedInstalledPackage(pluginDir, "@acme/plugin-test", "1.0.0");

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    // The heal must NOT fire — the real upgrade re-runs and repairs the disk.
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    const upgradeOrder = mockLifecycle.upgrade.mock.invocationCallOrder[0]!;
    const publishOrder = replication.publishSnapshot.mock.invocationCallOrder[0]!;
    expect(upgradeOrder).toBeLessThan(publishOrder);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects a traversal packageName in the disk check: a crafted file outside the plugin tree cannot satisfy the heal", async () => {
    const replication = createReplication();
    const { app, pluginDir } = await createApp(replication);
    // A package.json OUTSIDE the plugin tree (sibling of pluginDir) carrying
    // the target version, addressed via `..` segments in the row's
    // packageName (forgeable only with DB write access — defense in depth,
    // same threat model as the snapshot tarball guard). The disk check must
    // fail closed (treat as "not installed") instead of reading it, sending
    // the request down the repair path.
    const evilDir = `${pluginDir}-evil`;
    tmpPluginDirs.push(evilDir);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(path.join(evilDir, "package.json"), JSON.stringify({ version: "1.1.0" }));
    const evilPackageName = `../../${path.basename(evilDir)}`;
    mockRegistry.getById.mockResolvedValue({
      ...pluginRow,
      packageName: evilPackageName,
      version: "1.1.0",
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    // No heal despite row.version === target and the crafted out-of-tree
    // file matching: lifecycle.upgrade runs instead.
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not heal when the row is at a different version: the upgrade runs normally", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not heal an upgrade_pending row even at the target version: the approval flow still runs", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);
    const pendingRow = { ...pluginRow, version: "1.1.0", status: "upgrade_pending" };
    mockRegistry.getById.mockResolvedValue(pendingRow);
    mockLifecycle.upgrade.mockResolvedValue({ ...pendingRow, status: "ready" });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, "1.1.0");
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not heal an unpinned upgrade: the target is unknowable, lifecycle.upgrade runs", async () => {
    const replication = createReplication();
    const { app } = await createApp(replication);

    const res = await request(app).post(`/api/plugins/${PLUGIN_ID}/upgrade`).send({});

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(PLUGIN_ID, undefined);
    expect(replication.publishSnapshot).toHaveBeenCalledTimes(1);
  });
});
