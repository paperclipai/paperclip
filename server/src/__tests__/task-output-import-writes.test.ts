import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, taskProviderOutputPolicies } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import type { ImportIssueRow } from "../services/import-write-types.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("bulk task output disposition", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let constraintTable: "issues" | "task_provider_output_policies" | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-import-disposition-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (constraintTable) {
      await db.execute(sql.raw(`alter table ${constraintTable} drop constraint import_disposition_fault`));
      constraintTable = null;
    }
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic import", issuePrefix: `I${companyId.slice(0, 8)}` });
    return companyId;
  }

  function row(overrides: Partial<ImportIssueRow> = {}): ImportIssueRow & { providerOutputDisposition: "forbidden" } {
    return { id: randomUUID(), ref: "synthetic", title: "Synthetic task", description: "Synthetic description",
      projectId: null, projectWorkspaceId: null, assigneeAgentId: null, status: "backlog", priority: "medium",
      billingCode: null, assigneeAdapterOverrides: null, executionWorkspaceSettings: null, labelIds: [],
      monitorNotes: null, monitorScheduledBy: null, providerOutputDisposition: "forbidden", ...overrides };
  }

  async function assertEmpty(companyId: string) {
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.companyId, companyId))).toHaveLength(0);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(0);
  }

  it.each([undefined, null, "ordinary", "unknown", "FORBIDDEN", {}, false])("rejects a missing/invalid runtime decision %j before mutation", async decision => {
    const companyId = await fixture();
    const invalid = { ...row(), providerOutputDisposition: decision } as unknown as ImportIssueRow;
    const transaction = vi.spyOn(db, "transaction"), update = vi.spyOn(db, "update"), insert = vi.spyOn(db, "insert");
    await expect(issueService(db).importIssues(companyId, [row(), invalid])).rejects.toMatchObject({ status: 422,
      message: "Imported tasks require a server-resolved forbidden output disposition" });
    expect(transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    await assertEmpty(companyId);
  });

  it("commits a whole multi-chunk batch with destination-owned denial", async () => {
    const companyId = await fixture();
    const rows = Array.from({ length: 502 }, (_, i) => row({ ref: `task-${i}` }));
    rows[501].parentId = rows[0].id;
    await issueService(db).importIssues(companyId, rows);
    const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const policies = await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.companyId, companyId));
    expect(tasks).toHaveLength(502);
    expect(new Set(tasks.map(task => task.identifier)).size).toBe(502);
    expect(policies).toHaveLength(502);
    expect(policies.every(policy => policy.disposition === "forbidden")).toBe(true);
    expect(new Set(policies.map(policy => policy.issueId))).toEqual(new Set(rows.map(task => task.id)));
    expect(tasks.find(task => task.id === rows[501].id)?.parentId).toBe(rows[0].id);
  });

  it("does not expose tasks or denial outside its caller transaction and rolls back both", async () => {
    const companyId = await fixture(), task = row();
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).importIssues(companyId, [task]);
      expect(await taskForbidsProviderOutput(tx, { companyId, issueId: task.id })).toBe(true);
      await assertEmpty(companyId);
      throw new Error("Caller rollback");
    })).rejects.toThrow("Caller rollback");
    await assertEmpty(companyId);
  });

  it.each(["issues", "task_provider_output_policies"] as const)("rolls back all chunks and the counter when a late %s row fails", async table => {
    const companyId = await fixture();
    const rows = Array.from({ length: 502 }, (_, i) => row({ ref: `task-${i}` }));
    const column = table === "issues" ? "id" : "issue_id";
    constraintTable = table;
    await db.execute(sql.raw(`alter table ${table} add constraint import_disposition_fault check (${column} <> '${rows[501].id}'::uuid)`));
    await expect(issueService(db).importIssues(companyId, rows)).rejects.toThrow();
    await assertEmpty(companyId);
  });

  it("reconstructs services and cannot downgrade committed denial", async () => {
    const companyId = await fixture(), task = row();
    await issueService(db).importIssues(companyId, [task]);
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: task.id, disposition: "ordinary" });
    await issueService(db).addComment(task.id, "Native retained content", { userId: "local-board" });
    expect(await taskForbidsProviderOutput(db, { companyId, issueId: task.id })).toBe(true);
    await expect(issueService(db).importIssues(companyId, [task])).rejects.toThrow();
    expect(await taskForbidsProviderOutput(db, { companyId, issueId: task.id })).toBe(true);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });

  it("cannot attach a foreign task identity or rewrite its policy", async () => {
    const companyId = await fixture(), foreignId = await fixture(), task = row();
    await db.insert(issues).values({ id: task.id, companyId: foreignId, title: "Foreign ordinary task" });
    await retainTaskProviderOutputPolicy(db, { companyId: foreignId, issueId: task.id, disposition: "ordinary" });
    await expect(issueService(db).importIssues(companyId, [task])).rejects.toThrow();
    await assertEmpty(companyId);
    expect(await taskForbidsProviderOutput(db, { companyId: foreignId, issueId: task.id })).toBe(false);
  });

  it("does not trust extra ordinary/source metadata and leaves untouched local traffic alone", async () => {
    const companyId = await fixture(), otherId = await fixture();
    const ordinary = await issueService(db).create(companyId, { title: "Untouched ordinary work" });
    const other = await issueService(db).create(otherId, { title: "Other company work" });
    const task = { ...row(), sourceCompanyId: otherId, sourceIssueId: other.id, sourceTrust: { disposition: "promoted" }, ordinary: true };
    await issueService(db).importIssues(companyId, [task]);
    expect(await taskForbidsProviderOutput(db, { companyId, issueId: task.id })).toBe(true);
    for (const item of [ordinary, other]) {
      await issueService(db).addComment(item.id, "Ordinary native write", { userId: "local-board" });
      expect(await taskForbidsProviderOutput(db, { companyId: item.companyId, issueId: item.id })).toBe(false);
    }
  });

  it("empty batches remain a no-op", async () => {
    const companyId = await fixture();
    const transaction = vi.spyOn(db, "transaction");
    await issueService(db).importIssues(companyId, []);
    expect(transaction).not.toHaveBeenCalled();
    await assertEmpty(companyId);
  });
});
