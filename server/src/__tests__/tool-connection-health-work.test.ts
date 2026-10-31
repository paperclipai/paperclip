import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deleteCompany } from "../services/company-deletion.js";
import { notifyChatConnectionHealth } from "../services/chat-channels/connection-health-notifications.js";
import { smokeLabService } from "../services/smoke-lab.js";
import { toolAccessService } from "../services/tool-access.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";
import { applyPendingMigrations, companies, createDb, subscribeDatabaseWork, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { connectionHealthSchedule } from "../services/tool-access/catalog/health-schedule.js";
import { registerToolConnectionHealthWork } from "../services/tool-connection-health-work.js";
import { writeToolConnectionHealthChange } from "../services/tool-connection-health-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_HEALTH_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scheduled tool connection health", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, applicationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false;
  const errors: unknown[] = [];
  const probe = vi.fn();
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("tool-health-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Tool health", issuePrefix: `H${companyId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Health fixture", type: "mcp_http" }).returning();
    applicationId = app.id;
    probe.mockReset(); probe.mockImplementation(async (id: string) => {
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, id));
      await writeToolConnectionHealthChange(db, connection, async tx => {
        await tx.update(toolConnections).set({ healthCheckedAt: new Date(), healthStatus: "ok" }).where(eq(toolConnections.id, id));
      });
      return {};
    });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  function connection(patch: Partial<typeof toolConnections.$inferInsert> = {}, signal = true) {
    const id = patch.id ?? randomUUID();
    const insert = async (writer: typeof db) => (await writer.insert(toolConnections).values({
      id, companyId, applicationId, name: "Check", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true, ...patch,
    }).returning())[0];
    return signal ? writeToolConnectionHealthChange(db, { companyId, id }, insert) : insert(db);
  }
  async function start(service = connectionHealthSchedule(db, probe)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerToolConnectionHealthWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function idleAt(expected: number | null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBe(expected);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await idleAt(null);
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function checked(count = 1) {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(probe).toHaveBeenCalledTimes(count); }, { timeout: 5000 });
  }
  it("stays SQL-quiet after empty startup", async () => { await start(); await quiet(); });
  it("waits without SQL until a configured check is due", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt });
    await start(); const due = checkedAt.getTime() + 900_000; await idleAt(due);
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore();
    await vi.advanceTimersByTimeAsync(due - Date.now()); await checked();
  });
  it("refreshes only the changed connection after real API writes in a large company", async () => {
    const checkedAt = new Date();
    const rows = await db.insert(toolConnections).values(Array.from({ length: 205 }, (_, index) => ({
      companyId, applicationId, name: `Inventory ${index}`, uid: randomUUID(), transport: "mcp_remote" as const,
      config: { url: "https://health.example.test/mcp" },
      status: "active" as const, enabled: true, healthCheckedAt: checkedAt,
    }))).returning();
    const tools = toolAccessService(db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const service = tools.scheduledHealth, load = service.load;
    let returnedRows = 0;
    service.load = async (...args) => { const result = await load(...args); returnedRows += result.length; return result; };
    await start(service); await idleAt(checkedAt.getTime() + 900_000);
    returnedRows = 0;
    for (const row of rows.slice(0, 5)) {
      await tools.updateConnection(row.id, { name: `${row.name} changed` });
      await idleAt(checkedAt.getTime() + 900_000);
    }
    expect(returnedRows).toBe(5);
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(["example", "smoke"] as const)("does not reload unrelated connections when reinstalling %s metadata", async kind => {
    const settings = instanceSettingsService(db);
    const enabled = (await settings.getExperimental()).enableSmokeLab;
    const tools = toolAccessService(db);
    const smoke = smokeLabService(db, { deploymentMode: "local_trusted", deploymentExposure: "private" });
    const install = () => kind === "example" ? tools.installExample(companyId, "safe-read-only-todo-kv")
      : smoke.installFixtures(companyId);
    try {
      if (kind === "smoke") await settings.updateExperimental({ enableSmokeLab: true });
      await install();
      const fixtureConnections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
      const [application] = await db.select().from(toolApplications).where(and(
        eq(toolApplications.companyId, companyId), ne(toolApplications.id, applicationId),
      ));
      const checkedAt = new Date();
      const unrelated = await db.insert(toolConnections).values(Array.from({ length: 205 }, (_, index) => ({
        companyId, applicationId: application.id, name: `Other ${index}`, uid: randomUUID(),
        transport: "mcp_remote" as const, enabled: true, status: "active" as const,
        healthCheckedAt: checkedAt, config: { url: "https://health.example.test/mcp" },
      }))).returning({ id: toolConnections.id });
      await db.update(toolConnections).set({ healthCheckedAt: checkedAt }).where(eq(toolConnections.companyId, companyId));
      const service = connectionHealthSchedule(db, probe), load = service.load;
      let returnedRows = 0, excludedApplicationLoaded = false;
      const loadedIds = new Set<string>();
      service.load = async (...args) => {
        const rows = await load(...args); returnedRows += rows.length;
        for (const row of rows) loadedIds.add(row.id);
        if (args[2] === application.id && rows.length === 0) excludedApplicationLoaded = true;
        return rows;
      };
      await start(service); await idleAt(checkedAt.getTime() + 900_000); returnedRows = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        await install(); await idleAt(checkedAt.getTime() + 900_000);
      }
      expect(returnedRows).toBeLessThanOrEqual(10 * fixtureConnections.length);
      await writeToolConnectionHealthChange(db, { companyId, applicationId: application.id }, async tx => {
        await tx.update(toolApplications).set({ type: "paperclip_plugin" }).where(eq(toolApplications.id, application.id));
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(excludedApplicationLoaded).toBe(true));
      loadedIds.clear();
      await install();
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(unrelated.every(row => loadedIds.has(row.id))).toBe(true));
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      if (kind === "smoke") await settings.updateExperimental({ enableSmokeLab: enabled });
    }
  });

  it("notifies restored application eligibility after waiting for a concurrent type change", async () => {
    const tools = toolAccessService(db);
    const installed = await tools.installExample(companyId, "safe-read-only-todo-kv");
    const hints = new Set<string>();
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.toolConnectionHealth, (event, changed) => {
      if (event === "settled") for (const hint of changed ?? []) hints.add(hint);
    });
    let unlock!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const admitted = new Promise<void>(resolve => { acquired = resolve; });
    const holder = db.transaction(async tx => {
      await tx.update(toolApplications).set({ type: "paperclip_plugin" }).where(eq(toolApplications.id, installed.application.id));
      acquired(); await gate;
    });
    await admitted;
    let installing: ReturnType<typeof tools.installExample> | undefined;
    try {
      installing = tools.installExample(companyId, "safe-read-only-todo-kv");
      void installing.catch(() => undefined);
      await vi.waitFor(async () => {
        const waits = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%tool_applications%'`);
        expect(waits.length).toBe(1);
      });
      unlock(); await holder; await installing;
      expect(hints.has(`${companyId}:application:${installed.application.id}`)).toBe(true);
      expect((await db.select().from(toolApplications).where(eq(toolApplications.id, installed.application.id)))[0].type).toBe("mcp_stdio");
    } finally {
      unlock(); await Promise.allSettled([holder, installing]); unsubscribe();
    }
  });

  it("pages startup inventory while retaining every eligible deadline", async () => {
    const checkedAt = new Date();
    await db.insert(toolConnections).values(Array.from({ length: 205 }, (_, index) => ({
      companyId, applicationId, name: `Page ${index}`, uid: randomUUID(), transport: "mcp_remote" as const,
      status: "active" as const, enabled: true, healthCheckedAt: checkedAt,
    })));
    const reads = vi.spyOn(db, "select");
    const rows = await connectionHealthSchedule(db, probe).load(companyId);
    expect(rows).toHaveLength(205);
    expect(new Set(rows.map(row => row.id)).size).toBe(205);
    expect(reads).toHaveBeenCalledTimes(3);
    reads.mockRestore();
  });
  it("invalidates an application's cached deadlines without removing another application's work", async () => {
    const checkedAt = new Date();
    const [otherApp] = await db.insert(toolApplications).values({ companyId, name: "Other app", type: "mcp_http" }).returning();
    await connection({ healthCheckedAt: checkedAt });
    const other = await connection({ applicationId: otherApp.id, healthCheckedAt: new Date(checkedAt.getTime() + 60_000) });
    const service = connectionHealthSchedule(db, probe), load = vi.spyOn(service, "load");
    await start(service); await idleAt(checkedAt.getTime() + 900_000); load.mockClear();
    await writeToolConnectionHealthChange(db, { companyId, applicationId }, async tx => {
      await tx.update(toolApplications).set({ type: "paperclip_plugin" }).where(eq(toolApplications.id, applicationId));
    });
    await idleAt(other.healthCheckedAt!.getTime() + 900_000);
    expect(load).toHaveBeenCalledWith(companyId, undefined, applicationId, expect.any(AbortSignal));
    expect(load).toHaveBeenCalledTimes(1);
    await writeToolConnectionHealthChange(db, { companyId, applicationId }, async tx => {
      await tx.update(toolApplications).set({ type: "mcp_http" }).where(eq(toolApplications.id, applicationId));
    });
    await idleAt(checkedAt.getTime() + 900_000);
    expect(probe).not.toHaveBeenCalled();
  });
  it("keeps unrelated deadlines when a connection changes application or is deleted", async () => {
    const checkedAt = new Date();
    const first = await connection({ healthCheckedAt: checkedAt });
    const other = await connection({ healthCheckedAt: new Date(checkedAt.getTime() + 60_000) });
    const [plugin] = await db.insert(toolApplications).values({ companyId, name: "Excluded app", type: "paperclip_plugin" }).returning();
    await start(); await idleAt(checkedAt.getTime() + 900_000);
    await writeToolConnectionHealthChange(db, first, async tx => {
      await tx.update(toolConnections).set({ applicationId: plugin.id }).where(eq(toolConnections.id, first.id));
    });
    await idleAt(other.healthCheckedAt!.getTime() + 900_000);
    await writeToolConnectionHealthChange(db, other, async tx => { await tx.delete(toolConnections).where(eq(toolConnections.id, other.id)); });
    await quiet();
  });
  it("keeps disabled, archived, and excluded transports quiet", async () => {
    await connection({ enabled: false }); await connection({ status: "archived" });
    await connection({ transport: "chat_sdk", connectionPurpose: "channel" });
    await connection({ transport: "runtime_auth", connectionPurpose: "ai" });
    await start(); await quiet(); expect(probe).not.toHaveBeenCalled();
  });
  it("reactivates on the first committed connection and disarms after deletion", async () => {
    await start(); await quiet(); const row = await connection(); await checked();
    await writeToolConnectionHealthChange(db, companyId, async tx => { await tx.delete(toolConnections).where(eq(toolConnections.id, row.id)); });
    await quiet();
  });
  it("defers nested creation until the outer transaction commits and ignores rollback", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await writeToolConnectionHealthChange(tx as unknown as typeof db, companyId, async writer => {
        await writer.insert(toolConnections).values({ companyId, applicationId, name: "Rollback", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true });
      });
      await vi.advanceTimersByTimeAsync(60_000); expect(probe).not.toHaveBeenCalled();
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await quiet();
    await db.transaction(async tx => {
      await writeToolConnectionHealthChange(tx as unknown as typeof db, companyId, async writer => {
        await writer.insert(toolConnections).values({ companyId, applicationId, name: "Commit", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true });
      });
      await vi.advanceTimersByTimeAsync(60_000); expect(probe).not.toHaveBeenCalled();
    });
    await checked();
  });
  it("retains first writes through drain without querying", async () => {
    await start(); await quiet(); draining = true; await connection();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    const drained = idleWorkSnapshot();
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); expect(idleWorkSnapshot()).toEqual(drained);
    reads.mockRestore(); expect(probe).not.toHaveBeenCalled();
    draining = false; await checked();
  });
  it("moves the deadline when an actual-use health observation commits", async () => {
    const row = await connection({ healthCheckedAt: new Date() }); await start();
    const checkedAt = new Date(Date.now() + 60_000);
    await writeToolConnectionHealthChange(db, companyId, async tx => { await tx.update(toolConnections).set({ healthCheckedAt: checkedAt }).where(eq(toolConnections.id, row.id)); });
    await idleAt(checkedAt.getTime() + 900_000); expect(probe).not.toHaveBeenCalled();
  });
  it("reconstructs saved future checks after restart", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt }); await start();
    await coordinator!.stop(); await start(); await idleAt(checkedAt.getTime() + 900_000);
    await vi.advanceTimersByTimeAsync(checkedAt.getTime() + 900_000 - Date.now()); await checked();
  });
  it("drains more than one due page without repeatedly checking completed rows", async () => {
    for (let i = 0; i < 30; i++) await connection();
    const probedAt: number[] = [], performProbe = probe.getMockImplementation()!;
    probe.mockImplementation(async (id: string) => { probedAt.push(Date.now()); return performProbe(id); });
    await start(); await checked(30);
    expect(probedAt[25] - probedAt[24]).toBeLessThan(5_000);
    expect(new Set(probe.mock.calls.map(([id]) => id)).size).toBe(30);
  });
  it("checks the first connection created by the real API service after setup commits", async () => {
    const requests = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const tools = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: requests,
    });
    await start(tools.scheduledHealth); await quiet();
    const row = await tools.createConnection(companyId, { applicationId, name: "Real producer", transport: "mcp_remote", status: "active", enabled: true,
      config: { url: "https://health.example.test/mcp" } });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
      expect(stored.healthStatus).toBe("ok"); expect(stored.healthCheckedAt).not.toBeNull();
    }, { timeout: 5000 });
    expect(requests).toHaveBeenCalledOnce();
    await tools.updateConnection(row.id, { enabled: false }); await quiet();
    await tools.updateConnection(row.id, { enabled: true });
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
    await idleAt(stored.healthCheckedAt!.getTime() + 900_000);
    expect(requests).toHaveBeenCalledOnce();
    await tools.archiveConnection(row.id, companyId); await quiet();
  });

  it("checks a quiet company in the first batch despite another company's unchecked backlog", async () => {
    for (let index = 0; index < 30; index++) await connection({}, false);
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Quiet health", issuePrefix: `Q${otherId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId: otherId, name: "Quiet health", type: "mcp_http" }).returning();
    try {
      const [other] = await db.insert(toolConnections).values({
        companyId: otherId, applicationId: app.id, name: "Quiet", uid: randomUUID(), transport: "mcp_remote",
        status: "active", enabled: true, healthCheckedAt: new Date(Date.now() - 901_000),
      }).returning();
      await start();
      expect(probe).toHaveBeenCalledTimes(25);
      expect(probe.mock.calls.map(([id]) => id)).toContain(other.id);
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      await db.delete(companies).where(eq(companies.id, otherId));
    }
  });

  it("continues another company's checks when one scope cannot refresh", async () => {
    const service = connectionHealthSchedule(db, probe), load = service.load;
    await start(service); await quiet();
    service.load = async (...args) => { if (args[0] === companyId) throw new Error("scope unavailable"); return load(...args); };
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Other", issuePrefix: `O${otherId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId: otherId, name: "Other health", type: "mcp_http" }).returning();
    try {
      await connection();
      const [other] = await writeToolConnectionHealthChange(db, otherId, tx => tx.insert(toolConnections).values({
        companyId: otherId, applicationId: app.id, name: "Other", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true,
      }).returning());
      await checked(); expect(probe.mock.calls[0][0]).toBe(other.id);
    } finally { service.load = load; await db.delete(companies).where(eq(companies.id, otherId)); errors.length = 0; }
  });
  it("does not accelerate failed inventory reads while another company drains multiple pages", async () => {
    const service = connectionHealthSchedule(db, probe), load = service.load;
    await start(service); await quiet();
    const failedAt: number[] = [];
    service.load = async (...args) => {
      if (args[0] === companyId) { failedAt.push(Date.now()); throw new Error("scope unavailable"); }
      return load(...args);
    };
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Backlog", issuePrefix: `B${otherId.slice(0, 6)}` });
    const [app] = await db.insert(toolApplications).values({ companyId: otherId, name: "Backlog", type: "mcp_http" }).returning();
    try {
      draining = true;
      await connection();
      await writeToolConnectionHealthChange(db, otherId, tx => tx.insert(toolConnections).values(
        Array.from({ length: 60 }, () => ({ companyId: otherId, applicationId: app.id, name: "Due", uid: randomUUID(),
          transport: "mcp_remote" as const, status: "active" as const, enabled: true })),
      ));
      draining = false;
      await checked(60);
      expect(failedAt).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(failedAt.length).toBeGreaterThan(1));
      expect(failedAt.every((at, index) => index === 0 || at - failedAt[index - 1] >= 30_000)).toBe(true);
      service.load = load;
      await vi.advanceTimersByTimeAsync(30_000); await checked(61);
      await vi.advanceTimersByTimeAsync(31_000);
      const reads = vi.spyOn(db, "select");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    } finally {
      draining = false; service.load = load; await coordinator?.stop(); coordinator = undefined;
      await db.delete(companies).where(eq(companies.id, otherId)); errors.length = 0;
    }
  });
  it("cancels and restores experimental connector checks through the settings producer", async () => {
    const settings = instanceSettingsService(db);
    const original = (await settings.getExperimental()).enablePaperclipNotebook;
    try {
      await settings.updateExperimental({ enablePaperclipNotebook: false });
      await connection({ config: { sourceTemplateKey: "paperclip-notebook" } });
      await start(); await quiet(); expect(probe).not.toHaveBeenCalled();
      await settings.updateExperimental({ enablePaperclipNotebook: true });
      await checked();
      await settings.updateExperimental({ enablePaperclipNotebook: false });
      await quiet();
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      await settings.updateExperimental({ enablePaperclipNotebook: original });
    }
  });
  it("cancels a company's cached deadline when the real deletion service commits", async () => {
    const checkedAt = new Date(); await connection({ healthCheckedAt: checkedAt });
    await start(); await idleAt(checkedAt.getTime() + 900_000);
    await deleteCompany(db, companyId); await quiet(); expect(probe).not.toHaveBeenCalled();
  });
  it("keeps SDK-only chat mutations quiet and wakes the existing voice obligation", async () => {
    const voice = await connection({ transport: "voice", connectionPurpose: "channel", status: "draft", enabled: false });
    await start(); await quiet();
    await db.transaction(async tx => { await notifyChatConnectionHealth(tx, { companyId, connectionId: voice.id, provider: "slack" }); });
    await quiet();
    await db.transaction(async tx => {
      await notifyChatConnectionHealth(tx, { companyId, connectionId: voice.id, provider: "speko" });
      await tx.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, voice.id));
    });
    await checked(); expect(probe.mock.calls[0][0]).toBe(voice.id);
  });
  it("retains a producer wake arriving while its company is being refreshed", async () => {
    const service = connectionHealthSchedule(db, probe), load = service.load;
    await start(service); await quiet();
    let inserted = false;
    service.load = async (...args) => {
      const rows = await load(...args);
      if (args[0] === companyId && !inserted) { inserted = true; await connection(); }
      return rows;
    };
    await connection(); await checked(2);
    expect(new Set(probe.mock.calls.map(([id]) => id)).size).toBe(2);
  });
  it("backs off an unpersisted check without blocking another connection and recovers", async () => {
    const failed = await connection(), healthy = await connection();
    const persist = probe.getMockImplementation()!;
    let broken = true;
    probe.mockImplementation(async id => { if (id === failed.id && broken) throw new Error("health write unavailable"); return persist(id); });
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.mock.calls.some(([id]) => id === healthy.id)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
    });
    const before = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(probe).toHaveBeenCalledTimes(before);
    broken = false;
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, failed.id));
      expect(stored.healthCheckedAt).not.toBeNull();
    }, { timeout: 5000 });
    errors.length = 0;
  });
  it("awaits an admitted health check during shutdown and stops future work", async () => {
    await start(); await quiet();
    const persist = probe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    probe.mockImplementation(async id => { await gate; return persist(id); });
    await connection(); await checked();
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(); await stopping; coordinator = undefined;
    await vi.advanceTimersByTimeAsync(1_800_000); expect(probe).toHaveBeenCalledOnce();
  });

  it("warns for a persisted failed probe without retrying before its saved deadline", async () => {
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const requests = vi.fn(async () => new Response("private-provider-response", { status: 503 }));
    const tools = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: requests,
    });
    const row = await connection({ config: { url: "https://health.example.test/mcp" } });
    await start(tools.scheduledHealth);
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.id));
    expect(stored.healthCheckedAt).not.toBeNull();
    expect(warnings).toHaveBeenCalledWith(
      { companyId, connectionId: row.id }, "Scheduled tool connection health check failed",
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-provider-response");
    const due = stored.healthCheckedAt!.getTime() + 900_000;
    await idleAt(due);
    const before = requests.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(requests).toHaveBeenCalledTimes(before);
    expect(errors).toEqual([]);
  });

});
