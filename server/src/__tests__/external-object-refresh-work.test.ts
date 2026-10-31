import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, approvals, applyPendingMigrations, databaseWorkPending, budgetIncidents, budgetPolicies, companies, costEvents, createDb, externalObjects, externalObjectMentions, issues, issueComments, plugins } from "@paperclipai/db";
import { externalObjectService, type ExternalObjectResolveResult } from "../services/external-objects.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { budgetService } from "../services/budgets.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { notifyExternalObjectRefresh } from "../services/external-object-refresh-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
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
    if (url) await applyPendingMigrations(url);
    if (!url) temp = await startEmbeddedPostgresTestDatabase("external-refresh-work-");
    db = createDb(url ?? temp!.connectionString, { maxConnections: 6 });
    await db.execute(sql`truncate table ${companies} cascade`);
  }, 90_000);
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    for (const id of companyIds.splice(0)) {
      await db.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
      await db.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
      await db.delete(approvals).where(eq(approvals.companyId, id));
      await db.delete(costEvents).where(eq(costEvents.companyId, id));
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

  it.each(["company setting", "status", "uninstall", "manifest", "other company"] as const)(
    "revalidates the selected plugin after %s changes even while the built-in fallback remains available", async change => {
      clock(); const registry = pluginRegistryService(db);
      const manifest: PaperclipPluginManifestV1 = {
        id: `paperclip.selected-${randomUUID()}`, apiVersion: 1, version: "1.0.0", displayName: "Selected provider",
        description: "Selected resolver fixture", author: "Paperclip", categories: ["connector"],
        capabilities: ["external.objects.detect", "external.objects.read"], entrypoints: { worker: "worker.js" },
        objectReferences: [{ providerKey: "github", displayName: "GitHub", objectTypes: ["pull_request"], urlPatterns: ["https://github.com/:owner/:repo/pull/:id"] }],
      };
      const plugin = await registry.install({ packageName: "selected-provider-fixture" }, manifest);
      await registry.updateStatus(plugin!.id, { status: "ready" });
      let finishPlugin!: (result: ExternalObjectResolveResult) => void;
      const pluginResult = new Promise<ExternalObjectResolveResult>(resolve => { finishPlugin = resolve; });
      let selected = false;
      const calls = vi.fn(async (_id: string, method: string) => {
        if (method === "detectExternalObjects") return { detections: [] };
        selected = true; return pluginResult;
      });
      let finishFallback!: () => void;
      const fallbackResult = new Promise<void>(resolve => { finishFallback = resolve; });
      const fallback = vi.fn(async () => {
        await fallbackResult;
        return new Response(JSON.stringify({ state: "closed", merged: true, title: "Allowed fallback" }), { status: 200 });
      });
      const svc = externalObjectService(db, { pluginWorkerManager: { call: calls } as unknown as PluginWorkerManager,
        github: { fetch: fallback, credentialProvider: () => ({ token: "simulated-company-token", source: "company_secret" }) } });
      try {
        await start(svc); const f = await fixture();
        await db.update(issues).set({ description: "https://github.com/acme/app/pull/42" }).where(eq(issues.id, f.issueId));
        await svc.syncIssue(f.issueId); await settle(() => selected);
        if (change === "company setting") await registry.upsertCompanySettings(plugin!.id, f.companyId, { enabled: false, settingsJson: {} });
        else if (change === "status") await registry.updateStatus(plugin!.id, { status: "error" });
        else if (change === "uninstall") await registry.uninstall(plugin!.id, true);
        else if (change === "manifest") await registry.update(plugin!.id, { manifest: { ...manifest, capabilities: [], objectReferences: [] } });
        else {
          const other = await fixture();
          await registry.upsertCompanySettings(plugin!.id, other.companyId, { enabled: false, settingsJson: {} });
        }
        finishPlugin({ ok: true, snapshot: { statusKey: "plugin_result", statusCategory: "succeeded", statusTone: "success", isTerminal: true } });
        if (change === "other company") {
          await settle(async () => (await row(f.companyId))?.statusKey === "plugin_result"); await quiet();
          expect(fallback).not.toHaveBeenCalled();
        } else {
          await settle(async () => fallback.mock.calls.length > 0 || Boolean((await row(f.companyId))?.lastResolvedAt));
          const beforeFallback = await row(f.companyId);
          expect(beforeFallback.isTerminal).toBe(false); expect(beforeFallback.statusKey).toBeNull(); expect(beforeFallback.lastResolvedAt).toBeNull();
          expect(fallback).toHaveBeenCalledOnce();
          finishFallback();
          await settle(async () => (await row(f.companyId))?.statusKey === "merged"); await quiet();
          expect((await row(f.companyId)).displayTitle).toBe("acme/app#42: Allowed fallback");
        }
      } finally { finishPlugin(terminal); finishFallback(); }
    });

  it("reactivates refresh after ordinary budget pause and budget raise", async () => {
    clock(); const svc = service(); provider.mockResolvedValue(active); await start(svc);
    const f = await fixture(); await svc.syncIssue(f.issueId);
    await settle(async () => (await row(f.companyId))?.lastResolvedAt !== null);
    await db.insert(costEvents).values({ companyId: f.companyId, usageKind: "decision", provider: "fixture",
      biller: "fixture", billingType: "metered_api", model: "simulated", costCents: 200, occurredAt: new Date() });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId,
      amount: 100, hardStopEnabled: true }, null);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]!.status).toBe("paused");
    await quiet();
    const reads = vi.spyOn(db, "select"); provider.mockClear();
    await vi.advanceTimersByTimeAsync(900_000); expect(reads).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    provider.mockResolvedValue(terminal);
    await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 300 }, null);
    await settle(async () => (await row(f.companyId)).isTerminal); await quiet();
    expect(provider).toHaveBeenCalledOnce();
  });

  it.each(["comment", "document"] as const)("keeps hard-deleted %s activation scoped to its retained mention owner", async kind => {
    clock(); const svc = service(); provider.mockResolvedValue(active); await start(svc);
    const a = await fixture(); const b = await fixture(); await svc.syncIssue(b.issueId);
    let id: string;
    if (kind === "comment") {
      const [comment] = await db.insert(issueComments).values({ companyId: a.companyId, issueId: a.issueId,
        body: `https://example.com/${a.companyId}` }).returning();
      id = comment!.id; await svc.syncComment(id);
    } else {
      const result = await documentService(db).upsertIssueDocument({ issueId: a.issueId,
        key: "notes", format: "markdown", body: `https://example.com/${a.companyId}` });
      id = result.document.id; await svc.syncDocument(id);
    }
    await settle(async () => {
      const left = await row(a.companyId), right = await row(b.companyId);
      return Boolean(left?.lastResolvedAt && right?.lastResolvedAt);
    });
    const expectedDeadline = Math.min((await row(a.companyId)).nextRefreshAt!.getTime(), (await row(b.companyId)).nextRefreshAt!.getTime());
    await settle(() => coordinator!.nextWakeAt() === expectedDeadline && !databaseWorkPending(db, DELIVERY_QUEUES.externalObjectRefresh));
    const reads: Array<{ query: string; params: unknown[] }> = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, params) => {
      if (/^select/i.test(query) && query.includes('from "external_objects"') && query.includes('inner join "companies"'))
        reads.push({ query, params: [...params] });
    };
    try {
      if (kind === "comment") { await db.delete(issueComments).where(eq(issueComments.id, id)); await svc.syncComment(id); }
      else { await documentService(db).deleteIssueDocument(a.issueId, "notes"); await svc.syncDocument(id); }
      await settle(() => reads.length > 0);
      for (const read of reads) {
        expect(read.query).toContain('"external_objects"."company_id" =');
        expect(read.params).toContain(a.companyId); expect(read.params).not.toContain(b.companyId);
      }
    } finally { db.$client.options.debug = debug; }
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("scopes repeated issue deletions to cascaded source objects and cancels their last future mention", async () => {
    clock(); const svc = service();
    const own = await fixture(), foreign = await fixture();
    const future = new Date(Date.now() + 86_400_000), removedDeadline = new Date(Date.now() + 1_800_000);
    const sharedUrl = "https://example.com/shared-issue-object";
    const [retained] = await db.insert(issues).values({ companyId: own.companyId, title: "Retained",
      description: sharedUrl }).returning();
    await svc.syncIssue(retained!.id);
    await db.update(issues).set({ description: sharedUrl }).where(eq(issues.id, foreign.issueId));
    await svc.syncIssue(foreign.issueId);
    const deletions: Array<{ id: string; affected: string[]; orphaned: string[] }> = [];
    for (let index = 0; index < 3; index++) {
      const [issue] = await db.insert(issues).values({ companyId: own.companyId,
        title: sharedUrl, description: `https://example.com/deleted-${index}` }).returning();
      await svc.syncIssue(issue!.id);
      const [comment] = await db.insert(issueComments).values({ companyId: own.companyId, issueId: issue!.id,
        body: `https://example.com/comment-${index}` }).returning();
      await svc.syncComment(comment!.id);
      const doc = await documentService(db).upsertIssueDocument({ issueId: issue!.id, key: "notes", format: "markdown",
        body: `https://example.com/document-${index}` });
      await svc.syncDocument(doc.document.id);
      const mentions = await db.select().from(externalObjectMentions).where(and(
        eq(externalObjectMentions.companyId, own.companyId), eq(externalObjectMentions.sourceIssueId, issue!.id)));
      expect(new Set(mentions.map(mention => mention.sourceKind))).toEqual(new Set(["title", "description", "comment", "document"]));
      deletions.push({ id: issue!.id, affected: [...new Set(mentions.map(mention => mention.objectId!))],
        orphaned: mentions.filter(mention => mention.sourceKind !== "title").map(mention => mention.objectId!) });
    }
    const shared = (await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.sourceIssueId, retained!.id)))[0]!.objectId!;
    for (let offset = 0; offset < 1100; offset += 250) {
      const ids = Array.from({ length: Math.min(250, 1100 - offset) }, () => randomUUID());
      await db.insert(externalObjects).values(ids.map(id => ({ id, companyId: own.companyId,
        providerKey: "url", objectType: "link", externalId: id, nextRefreshAt: future })));
      await db.insert(externalObjectMentions).values(ids.map(objectId => ({ companyId: own.companyId,
        sourceIssueId: own.issueId, sourceKind: "description" as const, objectId })));
    }
    await db.update(externalObjects).set({ nextRefreshAt: future });
    for (const entry of deletions) for (const id of entry.orphaned)
      await db.update(externalObjects).set({ nextRefreshAt: removedDeadline }).where(eq(externalObjects.id, id));
    await start(svc);
    await settle(() => coordinator!.nextWakeAt() === removedDeadline.getTime() && !databaseWorkPending(db, DELIVERY_QUEUES.externalObjectRefresh));
    expect(provider).not.toHaveBeenCalled();
    const reads: Array<{ query: string; params: unknown[] }> = [];
    const selections: Array<{ query: string; params: unknown[] }> = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, params) => {
      if (/^select/i.test(query) && query.includes('from "external_objects"') && query.includes('inner join "companies"'))
        reads.push({ query, params: [...params] });
      if (/^select distinct/i.test(query) && query.includes('from "external_object_mentions"'))
        selections.push({ query, params: [...params] });
    };
    try {
      for (let index = 0; index < deletions.length; index++) {
        const entry = deletions[index], first = reads.length;
        const result = await issueService(db).remove(entry.id);
        expect(result?.id).toBe(entry.id);
        const next = index === deletions.length - 1 ? future : removedDeadline;
        await settle(() => reads.length > first && coordinator!.nextWakeAt() === next.getTime()
          && !databaseWorkPending(db, DELIVERY_QUEUES.externalObjectRefresh));
        const deletionReads = reads.slice(first);
        expect(deletionReads.length).toBeLessThanOrEqual(entry.affected.length);
        for (const read of deletionReads) {
          expect(read.query).toContain('"external_objects"."id" =');
          expect(read.params).toContain(own.companyId); expect(read.params).not.toContain(foreign.companyId);
          expect(read.params.some(value => entry.affected.includes(String(value)))).toBe(true);
        }
      }
      expect(selections).toHaveLength(deletions.length);
      for (let index = 0; index < selections.length; index++) {
        expect(selections[index]!.query).toContain('"external_object_mentions"."company_id" =');
        expect(selections[index]!.query).toContain('"external_object_mentions"."source_issue_id" =');
        expect(selections[index]!.params).toContain(own.companyId); expect(selections[index]!.params).toContain(deletions[index]!.id);
      }
      const lastMentions = await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.objectId, shared));
      expect(lastMentions).toHaveLength(1); expect(lastMentions[0]!.sourceIssueId).toBe(retained!.id);
      const orphanIds = deletions.flatMap(entry => entry.orphaned);
      const orphanRows = await db.select().from(externalObjects).where(inArray(externalObjects.id, orphanIds));
      expect(orphanRows).toHaveLength(orphanIds.length);
      for (const orphan of orphanRows) expect(orphan.nextRefreshAt).toEqual(removedDeadline);
      expect(await db.select().from(externalObjectMentions).where(inArray(externalObjectMentions.objectId, orphanIds))).toEqual([]);
      const foreignRows = await db.select().from(externalObjects).where(eq(externalObjects.companyId, foreign.companyId));
      expect(foreignRows).toHaveLength(1); expect(foreignRows[0]!.nextRefreshAt).toEqual(future);
      const count = reads.length;
      await vi.advanceTimersByTimeAsync(removedDeadline.getTime() - Date.now() + 1);
      expect(reads).toHaveLength(count); expect(provider).not.toHaveBeenCalled();
      expect(coordinator!.nextWakeAt()).toBe(future.getTime());
    } finally { db.$client.options.debug = debug; }
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

  it("uses durable provider retry deadlines and cancels the observed result on shutdown without overlap", async () => {
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
    await stop; expect(stopped).toBe(true); coordinator = undefined;
    const cancelled = await row(f.companyId); expect(cancelled.refreshToken).toBeNull(); expect(cancelled.isTerminal).toBe(false);
    finish(terminal); await delay(10);
    expect((await row(f.companyId)).isTerminal).toBe(false);
    const selects = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(selects).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledTimes(2);
  });

  it("cancels an actual stalled GitHub HTTP body, retains due debt and resumes after restart", async () => {
    clock(); let stall = true, started = false, closed = false;
    const server = createServer((request, response) => {
      if (request.url?.includes("/pulls/")) {
        if (stall) {
          started = true; response.on("close", () => { closed = true; });
          response.writeHead(200, { "content-type": "application/json" }); response.write('{"state":');
        } else response.end(JSON.stringify({ state: "closed", merged: true, title: "Done" }));
      } else response.end(JSON.stringify({ private: false }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing HTTP test port");
    const svc = externalObjectService(db, { github: {
      fetch: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init),
      credentialProvider: () => ({ token: "simulated-company-token", source: "company_secret" }),
    } });
    try {
      await start(svc); const f = await fixture();
      await db.update(issues).set({ description: "https://github.com/acme/app/pull/42" }).where(eq(issues.id, f.issueId));
      await svc.syncIssue(f.issueId); await settle(() => started);
      await coordinator!.stop(); coordinator = undefined;
      await settle(() => closed);
      const cancelled = await row(f.companyId);
      expect(cancelled.refreshToken).toBeNull(); expect(cancelled.lastResolvedAt).toBeNull();
      expect(cancelled.nextRefreshAt!.getTime()).toBeLessThanOrEqual(Date.now());
      stall = false; await start(svc);
      await settle(async () => Boolean((await row(f.companyId))?.isTerminal)); await quiet();
    } finally { await coordinator?.stop(); coordinator = undefined; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("loads only the changed identity and objects after ingestion into ten thousand future objects", async () => {
    clock(); const svc = service(); const f = await fixture();
    const future = new Date(Date.now() + 86_400_000);
    const ids = Array.from({ length: 10_000 }, () => randomUUID());
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      await db.insert(externalObjects).values(batch.map(id => ({ id, companyId: f.companyId,
        providerKey: "url", objectType: "link", externalId: id, nextRefreshAt: future })));
      await db.insert(externalObjectMentions).values(batch.map(objectId => ({ companyId: f.companyId,
        sourceIssueId: f.issueId, sourceKind: "description" as const, objectId })));
    }
    await start(svc); await settle(() => coordinator!.nextWakeAt() === future.getTime());
    const [incoming] = await db.insert(issues).values({ companyId: f.companyId, title: "Incoming",
      description: "https://example.com/new-object" }).returning();
    const reads: Array<{ query: string; params: unknown[] }> = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, params) => {
      if (/^select/i.test(query) && query.includes('from "external_objects"') && query.includes('inner join "companies"'))
        reads.push({ query, params: [...params] });
    };
    try {
      await svc.syncIssue(incoming!.id);
      await settle(() => provider.mock.calls.length === 1);
      await settle(() => coordinator!.nextWakeAt() === future.getTime() && !databaseWorkPending(db, DELIVERY_QUEUES.externalObjectRefresh));
      expect(reads.length).toBeGreaterThan(0); expect(reads.length).toBeLessThanOrEqual(6);
      for (const read of reads) expect(read.query).toMatch(/"external_objects"\."(?:id|external_id)" =/);
    } finally { db.$client.options.debug = debug; }
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
