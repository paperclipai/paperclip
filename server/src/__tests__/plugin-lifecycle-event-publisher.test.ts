import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { LifecycleEventPublisher } from "../services/plugin-lifecycle-event-bridge.js";

function makeManifest(id: string): PaperclipPluginManifestV1 {
  return {
    id,
    name: "Test Plugin",
    version: "1.0.0",
    description: "Test",
    apiVersion: 1,
    capabilities: ["events.subscribe"],
  } as PaperclipPluginManifestV1;
}

describe("plugin lifecycle → lifecycleEventPublisher (WS-3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-publisher-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: "TC",
      issueCounter: 0,
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertPlugin(pluginKey: string, status: string = "installed") {
    const manifest = makeManifest(pluginKey);
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: `@test/${pluginKey}`,
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: manifest,
      status,
      installOrder: 1,
      packagePath: null,
      lastError: null,
    });
    return pluginId;
  }

  it("calls publisher with plugin.installed when installed→ready (load)", async () => {
    const publisherCalls: Array<{ eventType: string }> = [];
    const publisher: LifecycleEventPublisher = vi.fn(async (eventType) => {
      publisherCalls.push({ eventType });
    });

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.install-plugin");
    await lifecycle.load(pluginId);

    expect(publisher).toHaveBeenCalledWith("plugin.installed", expect.objectContaining({ id: pluginId }));
    expect(publisherCalls.map((c) => c.eventType)).toContain("plugin.installed");
    expect(publisherCalls.map((c) => c.eventType)).not.toContain("plugin.enabled");
  });

  it("calls publisher with plugin.enabled when disabled→ready (enable)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {});

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.enable-plugin", "disabled");
    await lifecycle.enable(pluginId);

    expect(publisher).toHaveBeenCalledWith("plugin.enabled", expect.objectContaining({ id: pluginId }));
    const eventTypes = (publisher as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(eventTypes).not.toContain("plugin.installed");
  });

  it("calls publisher with plugin.disabled when ready→disabled", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {});

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.disable-plugin", "ready");
    await lifecycle.disable(pluginId, "test reason");

    expect(publisher).toHaveBeenCalledWith("plugin.disabled", expect.objectContaining({ id: pluginId }));
  });

  it("calls publisher with plugin.uninstalled BEFORE deactivatePluginRuntime (ordering)", async () => {
    const callOrder: string[] = [];
    const publisher: LifecycleEventPublisher = vi.fn(async (eventType) => {
      callOrder.push(`publisher:${eventType}`);
    });
    const mockWorkerManager = {
      isRunning: vi.fn(() => true),
      getWorker: vi.fn(() => ({ notify: vi.fn() })),
      stopWorker: vi.fn(async () => {
        callOrder.push("stopWorker");
      }),
      startWorker: vi.fn(async () => {}),
      restartWorker: vi.fn(async () => {}),
    };

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
      workerManager: mockWorkerManager as never,
    });

    const pluginId = await insertPlugin("test.uninstall-ordering", "ready");
    await lifecycle.unload(pluginId);

    const publisherIndex = callOrder.findIndex((e) => e === "publisher:plugin.uninstalled");
    const stopIndex = callOrder.findIndex((e) => e === "stopWorker");

    expect(publisherIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(publisherIndex).toBeLessThan(stopIndex);
  });

  it("does not throw when publisher fails during unload (teardown proceeds)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {
      throw new Error("Bus delivery failed");
    });

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.fail-publisher", "ready");
    await expect(lifecycle.unload(pluginId)).resolves.not.toThrow();
  });

  it("does not throw when publisher fails inside transition() during load (non-fatal)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {
      throw new Error("Bus delivery failed in transition");
    });

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.fail-publisher-transition");
    await expect(lifecycle.load(pluginId)).resolves.not.toThrow();
  });

  it("does not throw when no lifecycleEventPublisher is configured", async () => {
    const lifecycle = pluginLifecycleManager(db, {});
    const pluginId = await insertPlugin("test.no-publisher");
    await expect(lifecycle.load(pluginId)).resolves.not.toThrow();
  });

  it("upgrade with no new capabilities emits plugin.enabled (not plugin.installed)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {});

    const mockLoader = {
      discoverAll: vi.fn(async () => []),
      loadSingle: vi.fn(async () => ({ success: true, plugin: {} })),
      unloadSingle: vi.fn(async () => {}),
      hasRuntimeServices: vi.fn(() => false),
      cleanupInstallArtifacts: vi.fn(async () => {}),
      upgradePlugin: vi.fn(async () => {
        const manifest = makeManifest("test.upgrade-plugin");
        return {
          oldManifest: { ...manifest, capabilities: ["events.subscribe"] } as never,
          newManifest: { ...manifest, version: "2.0.0", capabilities: ["events.subscribe"] } as never,
          discovered: { version: "2.0.0" },
        };
      }),
    };

    const lifecycle = pluginLifecycleManager(db, {
      loader: mockLoader as never,
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.upgrade-plugin", "ready");
    await lifecycle.upgrade(pluginId);

    const eventTypes = (publisher as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(eventTypes).not.toContain("plugin.installed");
    expect(eventTypes).toContain("plugin.enabled");
  });

  it("error→ready transition emits plugin.enabled (not plugin.installed)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {});

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.error-recovery", "error");
    await lifecycle.enable(pluginId);

    const eventTypes = (publisher as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("plugin.enabled");
    expect(eventTypes).not.toContain("plugin.installed");
  });

  it("plugin.uninstalled is published only after registry.uninstall makes the status durable (F3 durable ordering)", async () => {
    const publishCalls: Array<{ eventType: string; dbStatus: string | undefined }> = [];
    const publisher: LifecycleEventPublisher = vi.fn(async (eventType) => {
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(plugins).where(eq(plugins.pluginKey, "test.durable-uninstall"));
      publishCalls.push({ eventType, dbStatus: rows[0]?.status });
    });

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.durable-uninstall", "ready");
    await lifecycle.unload(pluginId);

    const uninstalledCall = publishCalls.find((c) => c.eventType === "plugin.uninstalled");
    expect(uninstalledCall).toBeDefined();
    // DB must show "uninstalled" (soft-delete durable) BEFORE the event fires
    expect(uninstalledCall!.dbStatus).toBe("uninstalled");
  });

  it("hard-delete uninstall: plugin.uninstalled fires after row is deleted from DB", async () => {
    const publishCalls: Array<{ eventType: string; rowExists: boolean }> = [];
    const publisher: LifecycleEventPublisher = vi.fn(async (eventType) => {
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(plugins).where(eq(plugins.pluginKey, "test.hard-delete-uninstall"));
      publishCalls.push({ eventType, rowExists: rows.length > 0 });
    });

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.hard-delete-uninstall", "ready");
    await lifecycle.unload(pluginId, true);

    const uninstalledCall = publishCalls.find((c) => c.eventType === "plugin.uninstalled");
    expect(uninstalledCall).toBeDefined();
    // Row must be hard-deleted from DB BEFORE the event fires
    expect(uninstalledCall!.rowExists).toBe(false);
  });

  it("upgrade_pending→ready emits plugin.enabled (not plugin.installed)", async () => {
    const publisher: LifecycleEventPublisher = vi.fn(async () => {});

    const lifecycle = pluginLifecycleManager(db, {
      lifecycleEventPublisher: publisher,
    });

    const pluginId = await insertPlugin("test.upgrade-pending", "upgrade_pending");
    await lifecycle.enable(pluginId);

    const eventTypes = (publisher as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("plugin.enabled");
    expect(eventTypes).not.toContain("plugin.installed");
  });
});
