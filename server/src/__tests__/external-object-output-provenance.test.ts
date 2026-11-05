import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, externalObjectMentions, externalObjects, issues, plugins, taskProviderOutputPolicies } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { documentService } from "../services/documents.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { externalObjectService } from "../services/external-objects.js";
import { issueService } from "../services/issues.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const url = "https://github.com/acme/app/pull/42";

describePostgres("external object output provenance", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-external-output-");
    db = createDb(database.connectionString, { maxConnections: 6 });
  }, 90_000);
  afterEach(async () => { await db.delete(plugins); });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function fixture(restricted = true) {
    const companyId = randomUUID(), issueId = randomUUID(), ordinaryId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "External output", issuePrefix: `E${companyId.slice(0, 8)}` });
    await db.insert(issues).values([{ id: issueId, companyId, title: "Source", description: url },
      { id: ordinaryId, companyId, title: "Ordinary", description: url }]);
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: restricted ? "forbidden" : "ordinary" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: ordinaryId, disposition: "ordinary" });
    return { companyId, issueId, ordinaryId };
  }

  async function plugin(order = 1) {
    const manifest: PaperclipPluginManifestV1 = { id: `paperclip.output-${randomUUID()}`, apiVersion: 1, version: "1.0.0",
      displayName: "Output fixture", description: "Controlled external object provider", author: "Paperclip", categories: ["connector"],
      capabilities: ["external.objects.detect", "external.objects.read"], entrypoints: { worker: "dist/worker.js" },
      objectReferences: [{ providerKey: "fixture", displayName: "Fixture", objectTypes: ["ticket"], urlPatterns: ["https://github.com/:owner/:repo/pull/:id"] }] };
    return (await db.insert(plugins).values({ pluginKey: manifest.id, packageName: "output-fixture", version: manifest.version,
      apiVersion: 1, categories: manifest.categories, manifestJson: manifest, status: "ready", installOrder: order }).returning())[0]!;
  }

  function worker(onCall?: (method: string) => Promise<void>) {
    const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
      await onCall?.(method);
      if (method === "detectExternalObjects") return { detections: params.urls.map((entry: any) => ({
        urlIdentityHash: entry.canonicalIdentityHash, providerKey: "fixture", objectType: "ticket", externalId: "42", displayTitle: "Detector title",
      })) };
      if (method === "resolveExternalObject") return { ok: true, snapshot: { displayTitle: "Resolved title", statusCategory: "open", statusTone: "info" } };
      throw new Error(`Unexpected method ${method}`);
    });
    return { call, manager: { call } as unknown as PluginWorkerManager };
  }

  async function rows(companyId: string) {
    return { objects: await db.select().from(externalObjects).where(eq(externalObjects.companyId, companyId)),
      mentions: await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.companyId, companyId)) };
  }

  async function sync(kind: "title" | "description" | "comment" | "document", issueId: string, service: ReturnType<typeof externalObjectService>) {
    if (kind === "title" || kind === "description") {
      await db.update(issues).set({ title: kind === "title" ? url : "Source", description: kind === "description" ? url : null }).where(eq(issues.id, issueId));
      await service.syncIssue(issueId);
    } else if (kind === "comment") {
      const comment = await issueService(db).addComment(issueId, "Context text " + url, { userId: "operator" });
      await service.syncComment(comment.id);
    } else {
      const doc = await documentService(db).upsertIssueDocument({ issueId, key: "report", title: "Report", body: "Context text " + url,
        format: "markdown", createdByUserId: "operator" });
      await service.syncDocument(doc.document.id);
    }
  }

  for (const kind of ["title", "description", "comment", "document"] as const) {
    it(`${kind} cannot dispatch restricted text to a plugin or create a shared object`, async () => {
      const f = await fixture(); await plugin(); const w = worker();
      await sync(kind, f.issueId, externalObjectService(db, { pluginWorkerManager: w.manager }));
      expect(w.call).not.toHaveBeenCalled();
      expect(await rows(f.companyId)).toEqual({ objects: [], mentions: [] });
    });

    it(`${kind} preserves ordinary detector and resolver behavior without forwarding its body as context`, async () => {
      const f = await fixture(false); await plugin(); const w = worker();
      const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
      await sync(kind, f.issueId, svc);
      const saved = await rows(f.companyId);
      expect(saved.objects).toHaveLength(1); expect(saved.mentions).toHaveLength(1);
      const detection = w.call.mock.calls.find(([, method]) => method === "detectExternalObjects")!;
      expect(detection[2].sourceContext).toEqual({ companyId: f.companyId, sourceIssueId: f.issueId,
        sourceKind: kind, sourceRecordId: kind === "title" || kind === "description" ? null : expect.any(String),
        documentKey: kind === "document" ? "report" : null, propertyKey: null });
      const result = await svc.refreshObject(saved.objects[0].id, { companyId: f.companyId, force: true });
      expect(result).toMatchObject({ refreshed: true, object: { displayTitle: "Resolved title" } });
      expect(w.call.mock.calls.filter(([, method]) => method === "resolveExternalObject")).toHaveLength(1);
    });
  }

  it("restricted generic and built-in GitHub detection cannot populate company-shared state", async () => {
    const f = await fixture();
    for (const github of [false, undefined] as const) {
      await externalObjectService(db, { github }).syncIssue(f.issueId);
      expect(await rows(f.companyId)).toEqual({ objects: [], mentions: [] });
    }
  });

  it("uses the caller transaction's uncommitted output policy before detector dispatch", async () => {
    const f = await fixture(false); await plugin(); const w = worker();
    await db.transaction(async tx => {
      await retainTaskProviderOutputPolicy(tx, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
      await externalObjectService(db, { pluginWorkerManager: w.manager }).syncIssue(f.issueId, tx);
      expect(w.call).not.toHaveBeenCalled();
      tx.rollback();
    }).catch(error => { expect(error.message).toBe("Rollback"); });
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.issueId })).toBe(false);
    expect(await rows(f.companyId)).toEqual({ objects: [], mentions: [] });
  });

  it("does not overwrite an ordinary shared object's snapshot or retain restricted mentions", async () => {
    const f = await fixture(); await plugin(); const w = worker(); const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
    await svc.syncIssue(f.ordinaryId);
    const before = await rows(f.companyId); w.call.mockClear();
    await svc.syncIssue(f.issueId);
    expect(w.call).not.toHaveBeenCalled(); expect(await rows(f.companyId)).toEqual(before);
    await svc.refreshObject(before.objects[0].id, { companyId: f.companyId, force: true });
    expect(w.call).toHaveBeenCalledOnce();
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.ordinaryId })).toBe(false);
  });

  it("document deletion cannot release a retained restricted shared snapshot to a resolver", async () => {
    await plugin();
    for (const restricted of [false, true]) {
      const f = await fixture(false); const w = worker();
      const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
      const doc = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "report", title: "Report",
        body: "Historical source " + url, format: "markdown", createdByUserId: "operator" });
      await svc.syncDocument(doc.document.id);
      await svc.syncIssue(f.ordinaryId);
      const object = (await rows(f.companyId)).objects[0];
      if (restricted) {
        await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
        expect(await svc.refreshObject(object.id, { companyId: f.companyId, force: true }))
          .toMatchObject({ refreshed: false, reason: "task_output_forbidden" });
      }
      expect(await documentService(db).deleteIssueDocument(f.issueId, "report")).toMatchObject({ id: doc.document.id });
      await svc.syncDocument(doc.document.id);
      w.call.mockClear();
      const restarted = externalObjectService(db, { pluginWorkerManager: w.manager });
      const result = await restarted.refreshObject(object.id, { companyId: f.companyId, force: true });
      expect(w.call).toHaveBeenCalledTimes(restricted ? 0 : 1);
      expect(result).toMatchObject(restricted ? { refreshed: false, reason: "task_output_forbidden" }
        : { refreshed: true, reason: "resolved" });
      const saved = await rows(f.companyId);
      expect(saved.mentions.filter(mention => mention.sourceRecordId === doc.document.id)).toHaveLength(restricted ? 1 : 0);
      expect(saved.mentions.filter(mention => mention.sourceIssueId === f.ordinaryId)).toHaveLength(1);
      expect(saved.objects[0]).toMatchObject({ refreshStartedAt: null, refreshToken: null,
        ...(restricted ? { nextRefreshAt: null, lastResolvedAt: null } : { lastResolvedAt: expect.any(Date) }) });
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.ordinaryId })).toBe(false);
    }
  });

  it("task deletion cannot cascade away restricted shared-object provenance", async () => {
    await plugin();
    for (const restricted of [false, true]) {
      const f = await fixture(false); const w = worker();
      const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
      await svc.syncIssue(f.issueId); await svc.syncIssue(f.ordinaryId);
      const before = await rows(f.companyId); const object = before.objects[0];
      if (restricted) await retainTaskProviderOutputPolicy(db,
        { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
      const removal = issueService(db).remove(f.issueId);
      if (restricted) await expect(removal).rejects.toMatchObject({ status: 409 });
      else expect(await removal).toMatchObject({ id: f.issueId });
      expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toHaveLength(restricted ? 1 : 0);
      const saved = await rows(f.companyId);
      expect(saved.objects).toEqual(before.objects);
      expect(saved.mentions.filter(mention => mention.sourceIssueId === f.issueId)).toHaveLength(restricted ? 1 : 0);
      expect(saved.mentions.filter(mention => mention.sourceIssueId === f.ordinaryId)).toHaveLength(1);
      w.call.mockClear();
      const result = await externalObjectService(db, { pluginWorkerManager: w.manager })
        .refreshObject(object.id, { companyId: f.companyId, force: true });
      expect(w.call).toHaveBeenCalledTimes(restricted ? 0 : 1);
      expect(result).toMatchObject(restricted ? { refreshed: false, reason: "task_output_forbidden" }
        : { refreshed: true, reason: "resolved" });
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.ordinaryId })).toBe(false);
      if (restricted) expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
    }
    const unreferenced = await fixture();
    expect(await issueService(db).remove(unreferenced.issueId)).toMatchObject({ id: unreferenced.issueId });
  });

  it("orders task deletion against policy strengthening before its cascade commits", async () => {
    let f = await fixture(false); await plugin(); const w = worker();
    const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
    await svc.syncIssue(f.issueId); await svc.syncIssue(f.ordinaryId);
    const before = await rows(f.companyId);
    const remover = createDb(database.connectionString, { maxConnections: 1 });
    const transaction = remover.transaction.bind(remover);
    let probeCount = 0;
    let writerError: unknown;
    let writerCommitted = false;
    let limitDeleteWait = false;
    let probeBeforeMentions = false;
    let concurrentMention: typeof externalObjectMentions.$inferInsert | null = null;
    async function probeWriter() {
      probeCount++;
      try {
        await db.transaction(async writer => {
          await writer.execute(sql`set local lock_timeout = '100ms'`);
          await retainTaskProviderOutputPolicy(writer,
            { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
          if (concurrentMention) await writer.insert(externalObjectMentions).values(concurrentMention);
        });
        writerCommitted = true;
      } catch (error) { writerError = error; }
    }
    vi.spyOn(remover, "transaction").mockImplementation((callback: any) => transaction(async tx => {
      if (limitDeleteWait) await tx.execute(sql`set local lock_timeout = '100ms'`);
      if (probeBeforeMentions) {
        const select = tx.selectDistinct.bind(tx);
        vi.spyOn(tx, "selectDistinct").mockImplementation((fields: any) => {
          const query = select(fields);
          const from = query.from.bind(query);
          vi.spyOn(query, "from").mockImplementation((table: any) => {
            const source = from(table);
            if (table !== externalObjectMentions) return source;
            const where = source.where.bind(source);
            vi.spyOn(source, "where").mockImplementation((predicate: any) => {
              const filtered = where(predicate);
              const then = filtered.then.bind(filtered);
              vi.spyOn(filtered, "then").mockImplementation((resolve: any, reject: any) => (async () => {
                const found = await then(value => value);
                await probeWriter();
                return Promise.resolve(found).then(resolve, reject);
              })());
              return filtered;
            });
            return source;
          });
          return query;
        });
      }
      const remove = tx.delete.bind(tx);
      vi.spyOn(tx, "delete").mockImplementation((table: any) => {
        const query = remove(table);
        if (table !== issues) return query;
        const where = query.where.bind(query);
        vi.spyOn(query, "where").mockImplementation((predicate: any) => {
          const filtered = where(predicate);
          const returning = filtered.returning.bind(filtered);
          vi.spyOn(filtered, "returning").mockImplementation(() => {
            const result = returning();
            const then = result.then.bind(result);
            vi.spyOn(result, "then").mockImplementation((resolve: any, reject: any) => (async () => {
              if (!probeBeforeMentions) await probeWriter();
              return then(resolve, reject);
            })());
            return result;
          });
          return filtered;
        });
        return query;
      });
      return callback(tx);
    }));
    try {
      expect(await issueService(remover).remove(f.issueId)).toMatchObject({ id: f.issueId });
      expect(probeCount).toBe(1);
      expect(writerCommitted).toBe(false);
      expect((writerError as any)?.cause?.code ?? (writerError as any)?.code).toBe("55P03");
      expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toHaveLength(0);
      const saved = await rows(f.companyId);
      expect(saved.objects).toEqual(before.objects);
      expect(saved.mentions.filter(mention => mention.sourceIssueId === f.issueId)).toHaveLength(0);
      expect(saved.mentions.filter(mention => mention.sourceIssueId === f.ordinaryId)).toHaveLength(1);
      w.call.mockClear();
      expect(await externalObjectService(db, { pluginWorkerManager: w.manager })
        .refreshObject(saved.objects[0].id, { companyId: f.companyId, force: true }))
        .toMatchObject({ refreshed: true, reason: "resolved" });
      expect(w.call).toHaveBeenCalledOnce();
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.ordinaryId })).toBe(false);
      expect(await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, f.issueId))).toHaveLength(0);

      f = await fixture(false);
      await svc.syncIssue(f.issueId); await svc.syncIssue(f.ordinaryId);
      await db.delete(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, f.issueId));
      writerError = undefined; writerCommitted = false;
      expect(await issueService(remover).remove(f.issueId)).toMatchObject({ id: f.issueId });
      expect(probeCount).toBe(2);
      expect(writerCommitted).toBe(false);
      expect((writerError as any)?.cause?.code ?? (writerError as any)?.code).toBe("55P03");
      expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toHaveLength(0);
      expect(await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, f.issueId))).toHaveLength(0);
      expect((await rows(f.companyId)).mentions.map(mention => mention.sourceIssueId)).toEqual([f.ordinaryId]);

      f = await fixture(false);
      await svc.syncIssue(f.ordinaryId);
      const [ordinaryMention] = (await rows(f.companyId)).mentions;
      concurrentMention = { ...ordinaryMention, id: randomUUID(), sourceIssueId: f.issueId };
      probeBeforeMentions = true; writerError = undefined; writerCommitted = false;
      expect(await issueService(remover).remove(f.issueId)).toMatchObject({ id: f.issueId });
      expect(probeCount).toBe(3);
      expect(writerCommitted).toBe(false);
      expect((writerError as any)?.cause?.code ?? (writerError as any)?.code).toBe("55P03");
      expect((await rows(f.companyId)).mentions).toEqual([ordinaryMention]);
      expect(await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, f.issueId))).toHaveLength(0);
      concurrentMention = null; probeBeforeMentions = false;

      limitDeleteWait = true;
      for (const rollback of [false, true]) {
        const held = await fixture(false);
        await svc.syncIssue(held.issueId); await svc.syncIssue(held.ordinaryId);
        const retained = await rows(held.companyId);
        await db.transaction(async writer => {
          await retainTaskProviderOutputPolicy(writer,
            { companyId: held.companyId, issueId: held.issueId, disposition: "forbidden" });
          let deletionError: unknown;
          try { await issueService(remover).remove(held.issueId); }
          catch (error) { deletionError = error; }
          expect((deletionError as any)?.cause?.code ?? (deletionError as any)?.code).toBe("55P03");
          expect(await rows(held.companyId)).toEqual(retained);
          expect(await db.select().from(issues).where(eq(issues.id, held.issueId))).toHaveLength(1);
          if (rollback) writer.rollback();
        }).catch(error => {
          expect(rollback).toBe(true);
          expect(error.message).toBe("Rollback");
        });
        expect(probeCount).toBe(3);
        if (rollback) expect(await issueService(db).remove(held.issueId)).toMatchObject({ id: held.issueId });
        else await expect(issueService(db).remove(held.issueId)).rejects.toMatchObject({ status: 409 });
        w.call.mockClear();
        expect(await externalObjectService(db, { pluginWorkerManager: w.manager })
          .refreshObject(retained.objects[0].id, { companyId: held.companyId, force: true }))
          .toMatchObject(rollback ? { refreshed: true, reason: "resolved" }
            : { refreshed: false, reason: "task_output_forbidden" });
        expect(w.call).toHaveBeenCalledTimes(rollback ? 1 : 0);
        expect(await taskForbidsProviderOutput(db, { companyId: held.companyId, issueId: held.ordinaryId })).toBe(false);
      }
    } finally {
      vi.restoreAllMocks();
      await remover.$client.end({ timeout: 5 });
    }
  });

  it("drops detector results if the source becomes restricted during its authorized call", async () => {
    const f = await fixture(false); await plugin();
    const w = worker(async method => { if (method === "detectExternalObjects") await retainTaskProviderOutputPolicy(db,
      { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" }); });
    await externalObjectService(db, { pluginWorkerManager: w.manager }).syncIssue(f.issueId);
    expect(w.call).toHaveBeenCalledOnce(); expect(await rows(f.companyId)).toEqual({ objects: [], mentions: [] });
  });

  for (const provider of ["plugin", "github", "registered"] as const) {
    it(`${provider} refresh denies retained restricted provenance after restart without renewing the lease`, async () => {
      const f = await fixture(false); if (provider === "plugin") await plugin(); const w = worker();
      const resolve = vi.fn(async () => ({ ok: true as const, snapshot: { statusCategory: "open" as const, statusTone: "info" as const } }));
      const fetch = vi.fn(async () => new Response(JSON.stringify({ state: "open", title: "Ordinary", updated_at: "2026-01-01T00:00:00Z" }), { status: 200 }));
      const options = provider === "plugin" ? { pluginWorkerManager: w.manager }
        : provider === "github" ? { github: { tokenProvider: null, fetch } }
          : { github: false as const, resolvers: [{ providerKey: "url", resolve }] };
      await externalObjectService(db, options).syncIssue(f.issueId);
      const saved = (await rows(f.companyId)).objects[0]; w.call.mockClear();
      await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
      const restarted = externalObjectService(db, options);
      const result = await restarted.refreshObject(saved.id, { companyId: f.companyId, force: true });
      expect(w.call).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({ refreshed: false, reason: "task_output_forbidden" });
      expect((await rows(f.companyId)).objects[0]).toMatchObject({ refreshStartedAt: null, refreshToken: null, nextRefreshAt: null, lastResolvedAt: null });
      expect((await rows(f.companyId)).mentions).toHaveLength(1);
    });
  }

  it("does not let an ordinary mention authorize refresh of a retained restricted source", async () => {
    const f = await fixture(false); await plugin(); const w = worker(); const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
    await svc.syncIssue(f.issueId); await svc.syncIssue(f.ordinaryId);
    const before = await rows(f.companyId); expect(before.objects).toHaveLength(1); expect(before.mentions).toHaveLength(2);
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" }); w.call.mockClear();
    await svc.refreshIssueObjects(f.ordinaryId, { companyId: f.companyId });
    expect(w.call).not.toHaveBeenCalled();
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.ordinaryId })).toBe(false);
    expect(await db.select().from(externalObjectMentions).where(and(eq(externalObjectMentions.companyId, f.companyId),
      eq(externalObjectMentions.sourceIssueId, f.issueId)))).toHaveLength(1);
  });

  it.each(["plugin", "registered"] as const)("%s does not commit a shared resolver snapshot after source restriction", async provider => {
    const f = await fixture(false); if (provider === "plugin") await plugin();
    const restrict = () => retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
    const w = worker(async method => { if (method === "resolveExternalObject") await restrict(); });
    const resolve = vi.fn(async () => { await restrict();
      return { ok: true as const, snapshot: { displayTitle: "Resolved title", statusCategory: "open" as const, statusTone: "info" as const } }; });
    const svc = externalObjectService(db, provider === "plugin" ? { pluginWorkerManager: w.manager }
      : { github: false, resolvers: [{ providerKey: "url", resolve }] });
    await svc.syncIssue(f.issueId);
    const saved = (await rows(f.companyId)).objects[0]; w.call.mockClear();
    expect(await svc.refreshObject(saved.id, { companyId: f.companyId, force: true })).toMatchObject({ refreshed: false, reason: "task_output_forbidden" });
    expect(provider === "plugin" ? w.call : resolve).toHaveBeenCalledOnce();
    expect((await rows(f.companyId)).objects[0]).toMatchObject({ displayTitle: saved.displayTitle, lastResolvedAt: null, nextRefreshAt: null, refreshToken: null });
  });

  it("rechecks before each plugin and preserves old mentions if detection becomes restricted", async () => {
    const f = await fixture(false); await plugin(1); const ordinaryWorker = worker();
    await externalObjectService(db, { pluginWorkerManager: ordinaryWorker.manager }).syncIssue(f.issueId);
    const before = await rows(f.companyId); await plugin(2);
    const w = worker(async method => { if (method === "detectExternalObjects") await retainTaskProviderOutputPolicy(db,
      { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" }); });
    await externalObjectService(db, { pluginWorkerManager: w.manager }).syncIssue(f.issueId);
    expect(w.call).toHaveBeenCalledOnce(); expect(await rows(f.companyId)).toEqual(before);
    await db.update(issues).set({ description: null }).where(eq(issues.id, f.issueId));
    await externalObjectService(db, { pluginWorkerManager: w.manager }).syncIssue(f.issueId);
    expect(await rows(f.companyId)).toEqual(before);
  });

  it.each([true, false])("automatic refresh retains ordinary behavior and cancels restricted work (restricted=%s)", async restricted => {
    const f = await fixture(false); await plugin(); const w = worker();
    const svc = externalObjectService(db, { pluginWorkerManager: w.manager }); await svc.syncIssue(f.issueId);
    if (restricted) await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
    w.call.mockClear(); const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try { await svc.registerRefreshWork(coordinator, () => true).ready; } finally { await coordinator.stop(); }
    expect(errors).toEqual([]);
    const current = (await rows(f.companyId)).objects[0];
    expect(w.call.mock.calls.filter(([, method, params]) => method === "resolveExternalObject" && params.companyId === f.companyId)).toHaveLength(restricted ? 0 : 1);
    expect(current).toMatchObject({ refreshStartedAt: null, refreshToken: null,
      ...(restricted ? { nextRefreshAt: null, lastResolvedAt: null } : { displayTitle: "Resolved title", lastResolvedAt: expect.any(Date) }) });
  });

  it("keeps detection writes inside caller rollback and leaves no ordinary shared copy", async () => {
    const f = await fixture(false);
    await expect(db.transaction(async tx => {
      await externalObjectService(db).syncIssue(f.issueId, tx);
      expect(await tx.select().from(externalObjects).where(eq(externalObjects.companyId, f.companyId))).toHaveLength(1);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await rows(f.companyId)).toEqual({ objects: [], mentions: [] });
  });

  it("a restricted object's identity does not block the same ordinary identity in another company", async () => {
    const restricted = await fixture(false), ordinary = await fixture(false); await plugin(); const w = worker();
    const svc = externalObjectService(db, { pluginWorkerManager: w.manager });
    await svc.syncIssue(restricted.issueId); await svc.syncIssue(ordinary.issueId);
    await retainTaskProviderOutputPolicy(db, { companyId: restricted.companyId, issueId: restricted.issueId, disposition: "forbidden" });
    w.call.mockClear();
    await svc.refreshObject((await rows(restricted.companyId)).objects[0].id, { companyId: restricted.companyId, force: true });
    await svc.refreshObject((await rows(ordinary.companyId)).objects[0].id, { companyId: ordinary.companyId, force: true });
    expect(w.call).toHaveBeenCalledOnce(); expect(w.call.mock.calls[0][2].companyId).toBe(ordinary.companyId);
  });

  for (const boundary of ["credential", "public-probe", "not-found-probe"] as const) {
    it(`GitHub rechecks the task before dispatch after ${boundary}`, async () => {
      const f = await fixture(false);
      const restrict = () => retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.issueId, disposition: "forbidden" });
      const fetch = vi.fn(async () => {
        await restrict();
        return new Response(JSON.stringify({ private: false }), { status: boundary === "not-found-probe" ? 404 : 200 });
      });
      const svc = externalObjectService(db, { github: { fetch, credentialProvider: async () => {
        if (boundary === "credential") await restrict();
        return { token: "synthetic-token", source: boundary === "public-probe" ? "server_env" : "company_secret", secretName: null };
      } } });
      await svc.syncIssue(f.issueId); const saved = (await rows(f.companyId)).objects[0];
      const result = await svc.refreshObject(saved.id, { companyId: f.companyId, force: true });
      expect(fetch).toHaveBeenCalledTimes(boundary === "credential" ? 0 : 1);
      expect(result).toMatchObject({ refreshed: false, reason: "task_output_forbidden" });
      expect((await rows(f.companyId)).objects[0]).toMatchObject({ refreshToken: null, lastResolvedAt: null, nextRefreshAt: null });
    });
  }
});
