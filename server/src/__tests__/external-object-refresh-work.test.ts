import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, companies, createDb, externalObjects, issues, plugins } from "@paperclipai/db";
import { externalObjectService, type ExternalObjectResolveResult } from "../services/external-objects.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { notifyExternalObjectRefresh } from "../services/external-object-refresh-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_EXTERNAL_OBJECT_REFRESH_TEST_DATABASE_URL");
const support = url ? { supported: true } : await getEmbeddedPostgresTestSupport();
const terminal: ExternalObjectResolveResult = { ok: true, snapshot: {
  statusKey: "done", statusCategory: "succeeded", statusTone: "success", isTerminal: true,
} };
const active: ExternalObjectResolveResult = { ok: true, snapshot: {
  statusKey: "open", statusCategory: "open", statusTone: "neutral", isTerminal: false, ttlSeconds: 60,
} };

(support.supported ? describe : describe.skip)("external object refresh work (real PostgreSQL, simulated provider)", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let admitted = true;
  let reconcile = true;
  let enabled = true;
  const provider = vi.fn(async (): Promise<ExternalObjectResolveResult> => terminal);
  const errors = vi.fn();
  const companyIds: string[] = [];
  beforeAll(async () => {
    if (!url) temp = await startEmbeddedPostgresTestDatabase("external-refresh-work-");
    db = createDb(url ?? temp!.connectionString, { maxConnections: 6 });
    await db.execute(sql`truncate table ${companies} cascade`);
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    for (const id of companyIds.splice(0)) {
      await db.delete(activityLog).where(eq(activityLog.companyId, id));
      await db.delete(issues).where(eq(issues.companyId, id));
      await db.delete(externalObjects).where(eq(externalObjects.companyId, id));
      await db.delete(companies).where(eq(companies.id, id));
    }
    await db.delete(plugins);
    admitted = true; reconcile = true; enabled = true; errors.mockClear();
    provider.mockReset().mockResolvedValue(terminal);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  function service() {
    return externalObjectService(db, { github: false, enabled: () => enabled,
      resolvers: [{ providerKey: "url", resolve: provider }] });
  }
  async function start(svc = service()) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted,
      canReconcile: () => reconcile, onError: errors });
    const worker = svc.registerRefreshWork(coordinator, () => admitted);
    await worker.ready;
    return worker;
  }
  async function fixture(status = "active") {
    const id = randomUUID(); companyIds.push(id);
    await db.insert(companies).values({ id, name: "Refresh test", status,
      issuePrefix: `E${id.replaceAll("-", "").slice(0, 8)}` });
    const [issue] = await db.insert(issues).values({ companyId: id, title: "Reference",
      description: `https://example.com/${id}`, status: "todo" }).returning();
    return { companyId: id, issueId: issue!.id };
  }
  async function row(companyId: string) {
    return (await db.select().from(externalObjects).where(eq(externalObjects.companyId, companyId)))[0]!;
  }
  async function settle(predicate: () => Promise<boolean> | boolean) {
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(0); await delay(5);
      if (await predicate()) return;
    }
    throw new Error("refresh worker did not settle");
  }
  async function quiet() { await settle(() => coordinator!.nextWakeAt() === null); }
  function clock() { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true }); }
  async function change(companyId: string, patch: Partial<typeof externalObjects.$inferInsert>) {
    await db.transaction(async tx => {
      await notifyExternalObjectRefresh(tx, companyId);
      await tx.update(externalObjects).set(patch).where(eq(externalObjects.companyId, companyId));
    });
  }

  it("captures the old configured-empty aggregate SQL cost", async () => {
    const svc = service(); await fixture();
    const selects = vi.spyOn(db, "select");
    for (let i = 0; i < 3; i++) await svc.refreshDueObjectsForActiveCompanies();
    expect(selects).toHaveBeenCalledTimes(6);
    expect(provider).not.toHaveBeenCalled();
  });

  it("activates saved work when the ordinary feature and company settings enable it", async () => {
    clock(); const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableExternalObjects: true });
    const svc = externalObjectService(db, { github: false,
      enabled: async () => (await settings.getExperimental()).enableExternalObjects,
      resolvers: [{ providerKey: "url", resolve: provider }] });
    const f = await fixture("paused"); await svc.syncIssue(f.issueId);
    await settings.updateExperimental({ enableExternalObjects: false });
    await start(svc); await quiet();
    await companyService(db).update(f.companyId, { status: "active" }); await quiet();
    expect(provider).not.toHaveBeenCalled();
    await settings.updateExperimental({ enableExternalObjects: true });
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("settles empty, configured-idle and retained terminal history without recurring SQL or provider calls", async () => {
    clock();
    const svc = service(); await start(svc); await quiet();
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    const f = await fixture(); await svc.syncIssue(f.issueId);
    await settle(async () => (await row(f.companyId))?.isTerminal === true); await quiet();
    expect((await row(f.companyId)).statusKey).toBe("done");
    selects.mockClear(); provider.mockClear();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("registers exact future deadlines, preempts them on earlier writes and cancels terminal work", async () => {
    clock(); provider.mockResolvedValue(active);
    const svc = service(); await start(svc);
    const f = await fixture(); await svc.syncIssue(f.issueId);
    await settle(() => provider.mock.calls.length === 1);
    await settle(async () => (await row(f.companyId)).lastResolvedAt !== null);
    const saved = await row(f.companyId);
    await settle(() => coordinator!.nextWakeAt() === saved.nextRefreshAt!.getTime());
    const earlier = new Date(Date.now() + 1000); await change(f.companyId, { nextRefreshAt: earlier });
    await settle(() => coordinator!.nextWakeAt() === earlier.getTime());
    await vi.advanceTimersByTimeAsync(999); expect(provider).toHaveBeenCalledTimes(1);
    provider.mockResolvedValue(terminal); await vi.advanceTimersByTimeAsync(1);
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    await vi.advanceTimersByTimeAsync(120_000); expect(provider).toHaveBeenCalledTimes(2);
  });

  it("keeps disabled and paused company work passive and reconstructs on eligibility mutation", async () => {
    clock(); enabled = false;
    const svc = service(); await start(svc); await quiet();
    const f = await fixture("paused");
    enabled = true; await svc.syncIssue(f.issueId); await quiet();
    await vi.advanceTimersByTimeAsync(600_000); expect(provider).not.toHaveBeenCalled();
    await db.transaction(async tx => {
      await notifyExternalObjectRefresh(tx, f.companyId);
      await tx.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    });
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("waits for the outer commit and leaves rolled-back ingestion quiet", async () => {
    clock(); const svc = service(); await start(svc); await quiet();
    const f = await fixture();
    await expect(db.transaction(async tx => {
      await svc.syncIssue(f.issueId, tx); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await row(f.companyId)).toBeUndefined(); expect(provider).not.toHaveBeenCalled();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let nestedDone = false;
    const commit = db.transaction(async tx => {
      await tx.transaction(async nested => { await svc.syncIssue(f.issueId, nested); });
      nestedDone = true; await held;
    });
    await settle(() => nestedDone); await vi.advanceTimersByTimeAsync(60_000);
    expect(provider).not.toHaveBeenCalled(); release(); await commit;
    await settle(async () => (await row(f.companyId))?.isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("retains first work during drain and recovers a provider failure after restart", async () => {
    clock(); const svc = service(); await start(svc); await quiet();
    admitted = false; const f = await fixture(); await svc.syncIssue(f.issueId);
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(90_000); expect(provider).not.toHaveBeenCalled();
    selects.mockClear(); await vi.advanceTimersByTimeAsync(90_000); expect(selects).not.toHaveBeenCalled();
    admitted = true; provider.mockRejectedValueOnce(new Error("simulated transport failure"));
    await vi.advanceTimersByTimeAsync(30_000); await settle(() => errors.mock.calls.length === 1);
    const claimed = await row(f.companyId); expect(claimed.refreshToken).not.toBeNull();
    await coordinator!.stop(); coordinator = undefined; await start(svc);
    const due = claimed.refreshStartedAt!.getTime() + 300_000;
    expect(coordinator!.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1); expect(provider).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("leaves unsupported URLs passive and cancels orphan work until ordinary reattachment", async () => {
    clock(); const unsupported = externalObjectService(db, { github: false });
    await start(unsupported); const f = await fixture(); await unsupported.syncIssue(f.issueId); await quiet();
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(900_000); expect(selects).not.toHaveBeenCalled();
    expect((await row(f.companyId)).lastResolvedAt).toBeNull();
    await coordinator!.stop(); coordinator = undefined;
    provider.mockResolvedValue(active); const svc = service(); await start(svc);
    await settle(async () => (await row(f.companyId)).lastResolvedAt !== null);
    await db.update(issues).set({ description: null }).where(eq(issues.id, f.issueId));
    await svc.syncIssue(f.issueId); await quiet();
    selects.mockClear(); provider.mockClear();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    provider.mockResolvedValue(terminal);
    await db.update(issues).set({ description: `https://example.com/${f.companyId}` }).where(eq(issues.id, f.issueId));
    await svc.syncIssue(f.issueId);
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("activates a newly ready plugin and fences a result after company permission is withdrawn", async () => {
    clock(); const registry = pluginRegistryService(db);
    const manifest: PaperclipPluginManifestV1 = {
      id: `paperclip.refresh-${randomUUID()}`, apiVersion: 1, version: "1.0.0", displayName: "Refresh fixture",
      description: "Simulated external object provider", author: "Paperclip", categories: ["connector"],
      capabilities: ["external.objects.detect", "external.objects.read"], entrypoints: { worker: "worker.js" },
      objectReferences: [{ providerKey: "tracker", displayName: "Tracker", objectTypes: ["ticket"], urlPatterns: ["https://example.com/:id"] }],
    };
    const plugin = await registry.install({ packageName: "refresh-fixture" }, manifest);
    let finish!: (result: ExternalObjectResolveResult) => void;
    const calls = vi.fn(async (_id: string, method: string) => {
      if (method === "detectExternalObjects") return { detections: [] };
      if (calls.mock.calls.filter(call => call[1] === "resolveExternalObject").length === 1)
        return new Promise<ExternalObjectResolveResult>(resolve => { finish = resolve; });
      return terminal;
    });
    const svc = externalObjectService(db, { github: false,
      pluginWorkerManager: { call: calls } as unknown as PluginWorkerManager,
      detectors: [{ key: "fixture", detect: ({ urls }) => urls.map(canonical => ({ canonical,
        detectorKey: "fixture", providerKey: "tracker", objectType: "ticket", externalId: canonical.canonicalIdentityHash })) }],
    });
    await start(svc); const f = await fixture(); await svc.syncIssue(f.issueId); await quiet();
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(900_000); expect(selects).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled();
    await registry.updateStatus(plugin!.id, { status: "ready" });
    await settle(() => typeof finish === "function");
    await registry.upsertCompanySettings(plugin!.id, f.companyId, { enabled: false, settingsJson: {} });
    finish(terminal);
    await settle(async () => (await row(f.companyId)).refreshToken === null); await quiet();
    expect((await row(f.companyId)).isTerminal).toBe(false);
    selects.mockClear(); calls.mockClear();
    await vi.advanceTimersByTimeAsync(900_000); expect(selects).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled();
    calls.mockImplementation(async () => terminal);
    await registry.upsertCompanySettings(plugin!.id, f.companyId, { enabled: true, settingsJson: {} });
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(calls).toHaveBeenCalledOnce();
  });

  it("keeps warm standby startup SQL-free and resumes a first committed producer", async () => {
    clock(); admitted = false; reconcile = false;
    const svc = service(); const selects = vi.spyOn(db, "select");
    await start(svc); await vi.advanceTimersByTimeAsync(90_000);
    expect(selects).not.toHaveBeenCalled();
    const f = await fixture(); await svc.syncIssue(f.issueId);
    selects.mockClear(); await vi.advanceTimersByTimeAsync(90_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    admitted = true; reconcile = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(async () => (await row(f.companyId))?.isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("renews an active provider lease so another service cannot duplicate its action", async () => {
    clock(); const svc = service(); await start(svc);
    let finish!: (result: ExternalObjectResolveResult) => void;
    provider.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const f = await fixture(); await svc.syncIssue(f.issueId);
    await settle(() => provider.mock.calls.length === 1);
    const claimed = await row(f.companyId);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(async () => (await row(f.companyId)).refreshStartedAt!.getTime() > claimed.refreshStartedAt!.getTime());
    const competing = await service().refreshObject(claimed.id, { companyId: f.companyId,
      force: true, now: new Date(claimed.refreshStartedAt!.getTime() + 301_000) });
    expect(competing.reason).toBe("refresh_in_progress"); expect(provider).toHaveBeenCalledOnce();
    finish(terminal); await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
  });

  it("uses durable provider retry deadlines and waits for in-flight shutdown without overlap", async () => {
    clock(); const svc = service(); await start(svc);
    provider.mockResolvedValueOnce({ ok: false, liveness: "rate_limited", errorCode: "slow_down", retryAfterSeconds: 5 });
    const f = await fixture(); await svc.syncIssue(f.issueId);
    await settle(async () => (await row(f.companyId))?.lastErrorCode === "slow_down");
    const saved = await row(f.companyId);
    await settle(() => coordinator!.nextWakeAt() === saved.nextRefreshAt!.getTime());
    expect(saved.refreshToken).toBeNull();
    await vi.advanceTimersByTimeAsync(saved.nextRefreshAt!.getTime() - Date.now() - 1);
    expect(provider).toHaveBeenCalledOnce();
    let finish!: (result: ExternalObjectResolveResult) => void;
    provider.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(1); await settle(() => provider.mock.calls.length === 2);
    await svc.syncIssue(f.issueId); await vi.advanceTimersByTimeAsync(0);
    expect(provider).toHaveBeenCalledTimes(2);
    let stopped = false; const stop = coordinator!.stop().then(() => { stopped = true; });
    await delay(10); expect(stopped).toBe(false);
    finish(terminal); await stop; coordinator = undefined;
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledTimes(2);
  });

  it("reconstructs paginated multi-company work and never invokes inactive or never-refresh objects", async () => {
    clock(); const svc = service(); const a = await fixture(); const b = await fixture(); const inactive = await fixture("paused");
    for (const companyId of [b.companyId, inactive.companyId]) {
      await db.insert(externalObjects).values(Array.from({ length: 255 }, (_, index) => ({
        companyId, providerKey: "url", objectType: "link", externalId: String(index),
        sanitizedCanonicalUrl: `https://example.com/${companyId}/${index}`, canonicalIdentityHash: `${companyId}-${index}`,
        nextRefreshAt: null,
      })));
    }
    await db.update(issues).set({ description: Array.from({ length: 255 }, (_, index) =>
      `https://example.com/${a.companyId}/${index}`).join(" ") }).where(eq(issues.id, a.issueId));
    await svc.syncIssue(a.issueId);
    const future = new Date(Date.now() + 60_000);
    await db.update(externalObjects).set({ nextRefreshAt: future }).where(eq(externalObjects.companyId, a.companyId));
    await svc.syncIssue(b.issueId);
    await start(svc); await settle(() => provider.mock.calls.length === 1);
    await settle(() => coordinator!.nextWakeAt() === future.getTime());
    expect((await row(a.companyId)).nextRefreshAt).toEqual(future);
    const companiesSeen = provider.mock.calls.map(call => (call as unknown as [{ companyId: string }])[0].companyId);
    expect(companiesSeen).toEqual([b.companyId]);
    await change(a.companyId, { isTerminal: true }); await quiet();
    await vi.advanceTimersByTimeAsync(600_000); expect(provider).toHaveBeenCalledOnce();
  });
});
