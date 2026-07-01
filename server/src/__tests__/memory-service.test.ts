import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, memoryEntries } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const testActor = { actorType: "user" as const, actorId: "user-1", agentId: null, runId: null };

describeEmbeddedPostgres("memory service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(memoryEntries);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("ingests a memory entry and writes provenance to the activity log", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    const entry = await svc.ingest(
      companyId,
      { key: "context", title: "Project context", body: "# Context\n\nSome notes.", tags: ["notes"] },
      testActor,
    );

    expect(entry).toMatchObject({
      companyId,
      key: "context",
      title: "Project context",
      body: "# Context\n\nSome notes.",
      tags: ["notes"],
    });

    const activityRows = await db.select().from(activityLog);
    const relevant = activityRows.filter(
      (row) => row.action === "memory.ingested" && row.entityId === entry.id,
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toMatchObject({
      companyId,
      actorType: "user",
      actorId: "user-1",
      entityType: "memory_entry",
      entityId: entry.id,
    });
  });

  it("searches memory entries by text match", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    await svc.ingest(
      companyId,
      { key: "context", title: "Deploy notes", body: "How to deploy the service to prod.", tags: [] },
      testActor,
    );
    await svc.ingest(
      companyId,
      { key: "context", title: "Unrelated", body: "Nothing to do with deployment.", tags: [] },
      testActor,
    );

    const results = await svc.search(companyId, { query: "deploy", limit: 50 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => /deploy/i.test(r.title ?? "") || /deploy/i.test(r.body))).toBe(true);
  });

  it("browses memory entries filtered by key", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    await svc.ingest(companyId, { key: "context", body: "Context body" }, testActor);
    await svc.ingest(companyId, { key: "other", body: "Other body" }, testActor);

    const results = await svc.browse({ companyId, key: "context" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "context", body: "Context body" });
  });

  it("gets a memory entry by id and by key", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    const entry = await svc.ingest(companyId, { key: "context", body: "Body text" }, testActor);

    const byId = await svc.get(companyId, entry.id);
    expect(byId).toMatchObject({ id: entry.id, key: "context" });

    const byKey = await svc.get(companyId, "context");
    expect(byKey).toMatchObject({ id: entry.id, key: "context" });

    const missing = await svc.get(companyId, "does-not-exist");
    expect(missing).toBeNull();
  });

  it("forgets a memory entry and writes provenance to the activity log", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    const entry = await svc.ingest(companyId, { key: "context", body: "Body text" }, testActor);
    await svc.forget(companyId, entry.id, testActor);

    const afterForget = await svc.get(companyId, entry.id);
    expect(afterForget).toBeNull();

    const activityRows = await db.select().from(activityLog);
    const relevant = activityRows.filter(
      (row) => row.action === "memory.forgotten" && row.entityId === entry.id,
    );
    expect(relevant).toHaveLength(1);
  });

  it("reports usage counts for a company", async () => {
    const companyId = await insertCompany();
    const svc = memoryService(db);

    expect(await svc.usage(companyId)).toMatchObject({ count: 0, lastIngestedAt: null });

    await svc.ingest(companyId, { key: "context", body: "Body text" }, testActor);
    await svc.ingest(companyId, { key: "context", body: "Body text 2" }, testActor);

    const usage = await svc.usage(companyId);
    expect(usage.count).toBe(2);
    expect(usage.lastIngestedAt).not.toBeNull();
  });
});
