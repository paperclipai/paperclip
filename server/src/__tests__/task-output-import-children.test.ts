import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assets, companies, createDb, documentRevisions, documents, issueAttachments,
  issueComments, issueDocuments, issueWorkProducts, issues, taskProviderOutputPolicies,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { workProductService } from "../services/work-products.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const kinds = ["comment", "document", "attachment", "work_product"] as const;
type Kind = typeof kinds[number];
type Scope = { companyId: string; issueId: string; issueCommentId?: string | null };

function write(db: ReturnType<typeof createDb>, kind: Kind, scopes: Scope[]) {
  switch (kind) {
    case "comment": return issueService(db).addImportedComments(scopes.map(scope => ({
      ...scope, id: randomUUID(), body: "Synthetic imported comment", authorType: "system",
      authorAgentId: null, authorUserId: null, presentation: null, metadata: null, createdAt: null,
    })));
    case "document": return documentService(db).createIssueDocumentsForImport(scopes.map((scope, i) => ({
      ...scope, key: `import-${i}`, title: "Synthetic document", format: "markdown", body: "Synthetic imported document",
      createdByAgentId: null, createdByUserId: null, createdByRunId: null, sourceTrust: null,
    })));
    case "attachment": return issueService(db).addImportedAttachments(scopes.map(scope => ({
      ...scope, issueCommentId: scope.issueCommentId ?? null, provider: "local_disk", objectKey: `${scope.companyId}/issues/${scope.issueId}/synthetic/${randomUUID()}`,
      contentType: "text/plain", byteSize: 9, sha256: "0".repeat(64), originalFilename: "synthetic.txt",
      createdByAgentId: null, createdByUserId: null,
    })));
    case "work_product": return workProductService(db).createManyForImport(scopes.map(scope => ({
      ...scope, projectId: null, type: "artifact", provider: "local", externalId: null,
      title: "Synthetic work product", url: null, status: "draft", reviewState: "none", isPrimary: false,
      healthStatus: "unknown", summary: "Synthetic imported summary", metadata: null,
      executionWorkspaceId: null, runtimeServiceId: null, createdByRunId: null, sourceTrust: null,
    })));
  }
}

const childTables = { comment: issueComments, document: issueDocuments, attachment: issueAttachments, work_product: issueWorkProducts };

describePostgres("bulk imported child output ownership", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let faultTable: string | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-import-children-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (faultTable) {
      await db.execute(sql.raw(`alter table ${faultTable} drop constraint import_child_fault`));
      faultTable = null;
    }
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function fixture(disposition: "ordinary" | "forbidden" | null = "ordinary"): Promise<Scope> {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic import children", issuePrefix: `I${companyId.slice(0, 8)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic destination" });
    if (disposition) await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition });
    return { companyId, issueId };
  }

  async function assertEmpty(scope: Scope) {
    for (const table of [issueComments, issueDocuments, issueAttachments, issueWorkProducts]) {
      expect(await db.select({ id: table.id }).from(table).where(eq(table.companyId, scope.companyId))).toHaveLength(0);
    }
    for (const table of [assets, documents, documentRevisions]) {
      expect(await db.select({ id: table.id }).from(table).where(eq(table.companyId, scope.companyId))).toHaveLength(0);
    }
  }

  it.each(kinds)("%s atomically strengthens an ordinary destination without restricting unrelated work", async kind => {
    const scope = await fixture(), untouched = await fixture();
    await write(db, kind, [scope]);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    expect(await taskForbidsProviderOutput(db, untouched)).toBe(false);
    const table = childTables[kind];
    expect(await db.select({ id: table.id }).from(table).where(eq(table.companyId, scope.companyId))).toHaveLength(1);
    await retainTaskProviderOutputPolicy(db, { ...scope, disposition: "ordinary" });
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
  });

  it.each(kinds)("%s establishes denial on an unmarked destination and retains it across reconstruction", async kind => {
    const scope = await fixture(null);
    await write(db, kind, [scope]);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    await issueService(db).addComment(scope.issueId, "Native edit", { userId: "synthetic-board" });
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
  });

  it.each(kinds)("%s rejects a foreign task in a mixed batch without content or policy mutation", async kind => {
    const scope = await fixture(), foreign = await fixture();
    await expect(write(db, kind, [scope, { companyId: scope.companyId, issueId: foreign.issueId }])).rejects.toMatchObject({ status: 422 });
    await assertEmpty(scope);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
    expect(await taskForbidsProviderOutput(db, foreign)).toBe(false);
  });

  it.each(kinds)("%s rejects a missing destination and leaves the valid prefix unchanged", async kind => {
    const scope = await fixture();
    await expect(write(db, kind, [scope, { companyId: scope.companyId, issueId: randomUUID() }])).rejects.toMatchObject({ status: 422 });
    await assertEmpty(scope);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  });

  it.each(kinds)("%s rolls back its content when the policy write fails", async kind => {
    const scope = await fixture(null);
    faultTable = "task_provider_output_policies";
    await db.execute(sql.raw(`alter table ${faultTable} add constraint import_child_fault check (issue_id <> '${scope.issueId}'::uuid)`));
    await expect(write(db, kind, [scope])).rejects.toThrow();
    await assertEmpty(scope);
    expect(await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, scope.issueId))).toHaveLength(0);
  });

  it.each(kinds)("%s remains invisible outside its caller transaction and rolls back denial with content", async kind => {
    const scope = await fixture();
    await expect(db.transaction(async tx => {
      await write(tx as unknown as typeof db, kind, [scope]);
      expect(await taskForbidsProviderOutput(tx, scope)).toBe(true);
      expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
      await assertEmpty(scope);
      throw new Error("Caller rollback");
    })).rejects.toThrow("Caller rollback");
    await assertEmpty(scope);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  });

  it.each(kinds)("%s preserves committed denial when a late child chunk fails", async kind => {
    const scope = await fixture("forbidden"), second = await fixture();
    const tableByKind = { comment: "issue_comments", document: "issue_documents", attachment: "issue_attachments", work_product: "issue_work_products" };
    faultTable = tableByKind[kind];
    await db.execute(sql.raw(`alter table ${faultTable} add constraint import_child_fault check (issue_id <> '${second.issueId}'::uuid)`));
    await expect(write(db, kind, [...Array.from({ length: 501 }, () => scope), second])).rejects.toThrow();
    await assertEmpty(scope);
    await assertEmpty(second);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    expect(await taskForbidsProviderOutput(db, second)).toBe(false);
  });

  it.each(["another_task", "another_company", "missing"] as const)("rejects attachment comment ownership: %s", async variant => {
    const scope = await fixture(), other = await fixture();
    let issueCommentId = randomUUID();
    if (variant !== "missing") {
      const issueId = variant === "another_task"
        ? (await db.insert(issues).values({ companyId: scope.companyId, title: "Other task" }).returning())[0].id
        : other.issueId;
      const [comment] = await db.insert(issueComments).values({ companyId: variant === "another_task" ? scope.companyId : other.companyId,
        issueId, body: "Synthetic comment", authorType: "system" }).returning();
      issueCommentId = comment.id;
    }
    await expect(write(db, "attachment", [{ ...scope, issueCommentId }])).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(assets).where(eq(assets.companyId, scope.companyId))).toHaveLength(0);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.companyId, scope.companyId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
    expect(await taskForbidsProviderOutput(db, other)).toBe(false);
  });

  it("retains valid comment attachment ownership without changing source-trust metadata", async () => {
    const scope = await fixture();
    const sourceTrust = { preset: "low_trust_review" as const, disposition: "quarantined" as const, sourceIssueId: scope.issueId };
    const [comment] = await db.insert(issueComments).values({ ...scope, body: "Synthetic quarantined comment", authorType: "system", sourceTrust }).returning();
    await write(db, "attachment", [{ ...scope, issueCommentId: comment.id }]);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].sourceTrust).toEqual(sourceTrust);
    expect((await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, scope.issueId)))[0].issueCommentId).toBe(comment.id);
  });

  it.each(kinds)("%s rejects contradictory company claims for the same destination", async kind => {
    const scope = await fixture(), other = await fixture();
    await expect(write(db, kind, [scope, { companyId: other.companyId, issueId: scope.issueId }])).rejects.toMatchObject({ status: 422 });
    await assertEmpty(scope);
    await assertEmpty(other);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
    expect(await taskForbidsProviderOutput(db, other)).toBe(false);
  });

  it.each(kinds)("%s commits multiple valid companies with their own denial", async kind => {
    const first = await fixture(), second = await fixture();
    await write(db, kind, [second, first, second]);
    for (const scope of [first, second]) expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
  });

  it("batches ownership reads and policy writes across more than 500 destinations", async () => {
    const scope = await fixture();
    const tasks = Array.from({ length: 502 }, () => ({ companyId: scope.companyId, id: randomUUID(), title: "Synthetic batch task" }));
    await db.insert(issues).values(tasks);
    const original = db.transaction.bind(db);
    let policyInserts = 0;
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => original(async tx => {
      const insert = tx.insert.bind(tx);
      tx.insert = ((table: unknown) => {
        if (table === taskProviderOutputPolicies) policyInserts++;
        return insert(table as typeof taskProviderOutputPolicies);
      }) as typeof tx.insert;
      return callback(tx);
    }, config));
    await write(db, "comment", tasks.map(task => ({ companyId: task.companyId, issueId: task.id })));
    expect(policyInserts).toBe(2);
    expect((await db.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.companyId, scope.companyId)))
      .filter(row => row.disposition === "forbidden")).toHaveLength(502);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  });

  it("holds destination ownership before the first policy write", async () => {
    const scope = await fixture(null), other = await fixture();
    const original = db.transaction.bind(db);
    let ownershipProbed = false;
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => original(async tx => {
      const insert = tx.insert.bind(tx);
      tx.insert = ((table: unknown) => {
        const builder = insert(table as typeof taskProviderOutputPolicies);
        if (table === taskProviderOutputPolicies) {
          const values = builder.values.bind(builder);
          builder.values = ((input: Parameters<typeof values>[0]) => {
            const query = values(input), upsert = query.onConflictDoUpdate.bind(query);
            query.onConflictDoUpdate = (async options => {
              await expect(original(async competing => {
                await competing.execute(sql`set local lock_timeout = '100ms'`);
                await competing.update(issues).set({ companyId: other.companyId }).where(eq(issues.id, scope.issueId));
              })).rejects.toMatchObject({ cause: { code: "55P03" } });
              ownershipProbed = true;
              return upsert(options);
            }) as typeof query.onConflictDoUpdate;
            return query;
          }) as typeof builder.values;
        }
        return builder;
      }) as typeof tx.insert;
      return callback(tx);
    }, config));
    await write(db, "comment", [scope]);
    expect(ownershipProbed).toBe(true);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, scope.issueId)))[0].companyId).toBe(scope.companyId);
  });

  it("empty child batches remain a no-op", async () => {
    const transaction = vi.spyOn(db, "transaction");
    for (const kind of kinds) await write(db, kind, []);
    expect(transaction).not.toHaveBeenCalled();
  });
});
