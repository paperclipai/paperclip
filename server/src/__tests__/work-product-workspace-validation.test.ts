import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, issues, issueWorkProducts, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("work product execution workspace validation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-work-product-workspace-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test company", issuePrefix: companyId });
    await db.insert(projects).values({ id: projectId, companyId, name: "Test project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Test issue" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Test source" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      name: "Test execution", mode: "isolated_workspace", strategyType: "git_worktree",
    });
    return { companyId, projectId, issueId, projectWorkspaceId, executionWorkspaceId };
  }

  const input = { type: "pull_request", provider: "github", title: "Test output", status: "active", isPrimary: true };

  it.each(["missing", "project", "other company"])("rejects a %s workspace on create without replacing the primary", async (kind) => {
    const f = await fixture();
    const svc = workProductService(db);
    const primary = await svc.createForIssue(f.issueId, f.companyId, input);
    const invalidId = kind === "project" ? f.projectWorkspaceId
      : kind === "other company" ? (await fixture()).executionWorkspaceId : randomUUID();
    await expect(svc.createForIssue(f.issueId, f.companyId, { ...input, executionWorkspaceId: invalidId }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("Project workspace IDs are not execution workspace IDs") });
    expect(await svc.listForIssue(f.issueId)).toMatchObject([{ id: primary!.id, isPrimary: true }]);
  });

  it.each(["missing", "project", "other company"])("rejects a %s workspace on update without modifying either product", async (kind) => {
    const f = await fixture();
    const svc = workProductService(db);
    const primary = await svc.createForIssue(f.issueId, f.companyId, input);
    const secondary = await svc.createForIssue(f.issueId, f.companyId, { ...input, isPrimary: false, executionWorkspaceId: f.executionWorkspaceId });
    const invalidId = kind === "project" ? f.projectWorkspaceId
      : kind === "other company" ? (await fixture()).executionWorkspaceId : randomUUID();
    await expect(svc.update(secondary!.id, { executionWorkspaceId: invalidId, isPrimary: true, title: "Invalid change" }))
      .rejects.toMatchObject({ status: 422 });
    expect(await svc.getById(primary!.id)).toMatchObject({ isPrimary: true });
    expect(await svc.getById(secondary!.id)).toMatchObject({ isPrimary: false, title: input.title, executionWorkspaceId: f.executionWorkspaceId });
  });

  it("accepts same-company execution workspaces and preserves omitted versus null updates", async () => {
    const f = await fixture();
    const svc = workProductService(db);
    const product = await svc.createForIssue(f.issueId, f.companyId, { ...input, executionWorkspaceId: f.executionWorkspaceId });
    expect(product?.executionWorkspaceId).toBe(f.executionWorkspaceId);
    expect((await svc.update(product!.id, { title: "Updated" }))?.executionWorkspaceId).toBe(f.executionWorkspaceId);
    expect((await svc.update(product!.id, { executionWorkspaceId: null }))?.executionWorkspaceId).toBeNull();
    expect((await svc.update(product!.id, { executionWorkspaceId: f.executionWorkspaceId }))?.executionWorkspaceId).toBe(f.executionWorkspaceId);
    expect((await svc.createForIssue(f.issueId, f.companyId, { ...input, executionWorkspaceId: null }))?.executionWorkspaceId).toBeNull();
  });

  it("holds the validated reference until the insert commits, then permits ON DELETE SET NULL", async () => {
    const f = await fixture();
    let releaseInsert!: () => void;
    let validated!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const validationReached = new Promise<void>((resolve) => { validated = resolve; });
    // Pause immediately before the real INSERT, after validation has taken its lock.
    const gatedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async (tx) => {
          const wrapped = new Proxy(tx, {
            get(transaction, key, recv) {
              if (key !== "insert") return Reflect.get(transaction, key, recv);
              return (table: typeof issueWorkProducts) => ({ values: (values: typeof issueWorkProducts.$inferInsert) => ({
                returning: async () => { validated(); await insertGate; return transaction.insert(table).values(values).returning(); },
              }) });
            },
          });
          return callback(wrapped);
        });
      },
    });
    const create = workProductService(gatedDb).createForIssue(f.issueId, f.companyId, { ...input, executionWorkspaceId: f.executionWorkspaceId });
    try {
      await Promise.race([validationReached, create.then(() => { throw new Error("insert was not gated"); })]);
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.executionWorkspaceId));
      })).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      releaseInsert();
    }
    const product = await create;
    expect(product?.executionWorkspaceId).toBe(f.executionWorkspaceId);
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.executionWorkspaceId));
    expect((await workProductService(db).getById(product!.id))?.executionWorkspaceId).toBeNull();
  });
});
