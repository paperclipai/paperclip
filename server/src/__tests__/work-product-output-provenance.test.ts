import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueWorkProducts } from "@paperclipai/db";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { workProductService } from "../services/work-products.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const bindings = ["native", "legacy", "context-issue", "context-task"] as const;
const input = { type: "artifact", provider: "local", title: "Synthetic source result", status: "draft", summary: "Synthetic source content" };

describePostgres("work product writers retain task output provenance", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-work-product-output-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function fixture(binding: typeof bindings[number] = "legacy", restricted = true) {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), targetId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Work product provenance", issuePrefix: `W${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "process" });
    await db.insert(issues).values([{ id: sourceId, companyId, title: "Source" }, { id: targetId, companyId, title: "Destination" }]);
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: sourceId, disposition: restricted ? "forbidden" : "ordinary" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: targetId, disposition: "ordinary" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "assignment",
      ...(binding === "native" ? { nativeIssueId: sourceId } : binding === "legacy" ? { issueId: sourceId }
        : { contextSnapshot: binding === "context-issue" ? { issueId: sourceId } : { taskId: sourceId } }) });
    if (binding === "context-issue" || binding === "context-task") await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, sourceId, targetId, runId };
  }

  const denied = (f: Awaited<ReturnType<typeof fixture>>) => taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId });

  it.each(bindings)("create inherits the %s writer's restriction", async binding => {
    const f = await fixture(binding);
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, { ...input, createdByRunId: f.runId });
    expect(product?.createdByRunId).toBe(f.runId);
    expect(await denied(f)).toBe(true);
  });

  it.each(bindings)("update inherits the %s current actor without rewriting original attribution", async binding => {
    const f = await fixture(binding);
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, input);
    const updated = await workProductService(db).update(product!.id, { summary: "New synthetic source content" }, { actorRunId: f.runId });
    expect(updated?.createdByRunId).toBeNull();
    expect(updated?.summary).toBe("New synthetic source content");
    expect(await denied(f)).toBe(true);
  });

  it("update inherits explicit accepted run attribution", async () => {
    const f = await fixture();
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, input);
    await workProductService(db).update(product!.id, { summary: "Attributed source content", createdByRunId: f.runId });
    expect(await denied(f)).toBe(true);
  });

  it("replay retains a newly restricted original source", async () => {
    const f = await fixture("legacy", false);
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, { ...input, createdByRunId: f.runId });
    expect(await denied(f)).toBe(false);
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.sourceId, disposition: "forbidden" });
    const updated = await workProductService(db).update(product!.id, { title: input.title });
    expect(updated?.id).toBe(product?.id);
    expect(await workProductService(db).listForIssue(f.targetId)).toHaveLength(1);
    expect(await denied(f)).toBe(true);
  });

  it("an ordinary attribution change does not hide the restricted current writer", async () => {
    const f = await fixture(), ordinary = randomUUID();
    await db.insert(heartbeatRuns).values({ id: ordinary, companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", invocationSource: "assignment", issueId: f.targetId });
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, input);
    await workProductService(db).update(product!.id, { createdByRunId: ordinary, summary: "Restricted update" }, { actorRunId: f.runId });
    expect(await denied(f)).toBe(true);
  });

  it("clearing original attribution cannot erase its newly restricted provenance", async () => {
    const f = await fixture("legacy", false);
    const product = await workProductService(db).createForIssue(f.targetId, f.companyId, { ...input, createdByRunId: f.runId });
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.sourceId, disposition: "forbidden" });
    expect((await workProductService(db).update(product!.id, { createdByRunId: null }))?.createdByRunId).toBeNull();
    expect(await denied(f)).toBe(true);
  });

  for (const operation of ["create", "update"] as const) {
    it(`${operation} keeps an ordinary writer usable`, async () => {
      const f = await fixture("legacy", false);
      const svc = workProductService(db);
      if (operation === "create") await svc.createForIssue(f.targetId, f.companyId, { ...input, createdByRunId: f.runId });
      else {
        const product = await svc.createForIssue(f.targetId, f.companyId, input);
        await svc.update(product!.id, { summary: "Ordinary update" }, { actorRunId: f.runId });
      }
      expect(await denied(f)).toBe(false);
    });

    it(`${operation} rolls back content and restriction in the caller transaction`, async () => {
      const f = await fixture();
      const product = operation === "update" ? await workProductService(db).createForIssue(f.targetId, f.companyId, input) : null;
      await expect(db.transaction(async tx => {
        const svc = workProductService(tx as unknown as typeof db);
        if (product) await svc.update(product.id, { summary: "Rolled back" }, { actorRunId: f.runId });
        else await svc.createForIssue(f.targetId, f.companyId, { ...input, createdByRunId: f.runId });
        expect(await taskForbidsProviderOutput(tx, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
        expect(await denied(f)).toBe(false);
        throw new Error("Caller rollback");
      })).rejects.toThrow("Caller rollback");
      expect(await denied(f)).toBe(false);
      const rows = await workProductService(db).listForIssue(f.targetId);
      expect(rows).toHaveLength(product ? 1 : 0);
      if (product) expect(rows[0].summary).toBe(input.summary);
    });

    it(`${operation} validation failure leaves content and restriction unchanged`, async () => {
      const f = await fixture(), svc = workProductService(db);
      const primary = await svc.createForIssue(f.targetId, f.companyId, { ...input, isPrimary: true });
      const invalid = { ...input, isPrimary: true, executionWorkspaceId: randomUUID(), createdByRunId: f.runId };
      const attempt = operation === "create" ? svc.createForIssue(f.targetId, f.companyId, invalid)
        : svc.update(primary!.id, invalid, { actorRunId: f.runId });
      await expect(attempt).rejects.toMatchObject({ status: 422 });
      expect(await denied(f)).toBe(false);
      expect(await svc.listForIssue(f.targetId)).toMatchObject([{ id: primary!.id, isPrimary: true, executionWorkspaceId: null }]);
    });

    it(`${operation} restriction survives source, run and product deletion`, async () => {
      const f = await fixture(), svc = workProductService(db);
      const product = await svc.createForIssue(f.targetId, f.companyId, { ...input, ...(operation === "create" ? { createdByRunId: f.runId } : {}) });
      if (operation === "update") await svc.update(product!.id, { summary: "Restricted update" }, { actorRunId: f.runId });
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.delete(issues).where(eq(issues.id, f.sourceId));
      await workProductService(db).remove(product!.id);
      await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.targetId, disposition: "ordinary" });
      expect(await denied(f)).toBe(true);
    });
  }

  it("a service-level same-company move retains its original task restriction", async () => {
    const f = await fixture();
    const product = await workProductService(db).createForIssue(f.sourceId, f.companyId, input);
    await workProductService(db).update(product!.id, { issueId: f.targetId });
    await db.delete(issues).where(eq(issues.id, f.sourceId));
    expect(await denied(f)).toBe(true);
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id))).toHaveLength(1);
  });

  it("foreign-company actor provenance never changes the local task policy", async () => {
    const f = await fixture("legacy", false), other = await fixture();
    const svc = workProductService(db), product = await svc.createForIssue(f.targetId, f.companyId, input);
    await svc.update(product!.id, { summary: "Local content" }, { actorRunId: other.runId });
    expect(await denied(f)).toBe(false);
  });

  it("unattributed board writes preserve ordinary tasks and cannot downgrade restricted ones", async () => {
    const f = await fixture(), svc = workProductService(db);
    const product = await svc.createForIssue(f.targetId, f.companyId, input);
    await svc.update(product!.id, { summary: "Board-authored content" });
    expect(await denied(f)).toBe(false);
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.targetId, disposition: "forbidden" });
    await svc.update(product!.id, { summary: "Updated board content", createdByRunId: null });
    expect(await denied(f)).toBe(true);
  });
});
