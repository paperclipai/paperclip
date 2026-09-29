import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  nativeToolReceiptReferences,
  nativeToolReceipts,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import {
  findNativeToolReceiptReference,
  insertNativeToolReceipt,
  readNativeToolReceipt,
  type NativeToolReceipt,
  type NativeToolReceiptBinding,
} from "./native-tool-receipts.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe.sequential : describe.skip;

type Owner = NativeToolReceiptBinding & { agentId: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const receipt = (operationId: string, input: unknown = {}, result: unknown = {}): NativeToolReceipt => ({ operationId, input, result });

describePostgres("native tool receipt persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let owner: Owner;
  let other: Owner;

  async function createOwner(companyName: string): Promise<Owner> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyName, issuePrefix: `${companyName.slice(0, 2).toUpperCase()}${randomUUID().slice(0, 2).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: `${companyName} agent`, status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await db.insert(issues).values({ id: issueId, companyId, title: `${companyName} issue`, status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "assignment", triggerDetail: "system", resultJson: { stable: "unchanged" }, contextSnapshot: { issueId } });
    return { companyId, issueId, runId, agentId };
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-tool-receipts-");
    db = createDb(temporary.connectionString);
    owner = await createOwner("Receipt primary");
    other = await createOwner("Receipt other");
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("keeps thousands of receipts outside result_json and replays the oldest exact key", async () => {
    const oldestKey = `oldest-${"legacy-key-".repeat(512)}`;
    const oldest = receipt("write_document", { title: "exact" }, { disposition: "applied", documentId: randomUUID() });
    await insertNativeToolReceipt(db, owner, oldestKey, oldest);
    const filler = Array.from({ length: 1_200 }, (_, index) => ({
      ...owner,
      keySha256: digest(`late-${index}`),
      idempotencyKey: `late-${index}`,
      receipt: receipt("ordinary_read", { index }, { value: index }),
    }));
    for (let offset = 0; offset < filler.length; offset += 300) {
      await db.insert(nativeToolReceipts).values(filler.slice(offset, offset + 300));
    }

    const replay = await readNativeToolReceipt(db, owner, oldestKey);
    expect(replay).toEqual(oldest);
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(nativeToolReceipts).where(and(
      eq(nativeToolReceipts.companyId, owner.companyId), eq(nativeToolReceipts.runId, owner.runId),
    ));
    const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(count?.count).toBe(1_201);
    expect(run?.resultJson).toEqual({ stable: "unchanged" });
  });

  it("rejects mismatched company and issue ownership through the database foreign key", async () => {
    const makeRow = (companyId: string, issueId: string, runId: string, key: string) => ({
      companyId, issueId, runId, keySha256: digest(key), idempotencyKey: key,
      receipt: receipt("ordinary_read", {}, {}),
    });
    await expect(db.insert(nativeToolReceipts).values(makeRow(other.companyId, owner.issueId, owner.runId, "wrong-company"))).rejects.toThrow();
    await expect(db.insert(nativeToolReceipts).values(makeRow(owner.companyId, other.issueId, owner.runId, "wrong-issue"))).rejects.toThrow();
  });

  it("fails closed when the digest resolves to a different exact key or a malformed receipt", async () => {
    const key = "digest-collision-corruption";
    await db.insert(nativeToolReceipts).values({ ...owner, keySha256: digest(key), idempotencyKey: `${key}-different`, receipt: receipt("ordinary_read") });
    await expect(readNativeToolReceipt(db, owner, key)).rejects.toThrow("native_tool_receipt_binding_mismatch");
    await expect(readNativeToolReceipt(db, owner, "legacy-null", { "legacy-null": null })).rejects.toThrow("native_tool_receipt_invalid");
    await expect(readNativeToolReceipt(db, owner, "legacy-malformed", { "legacy-malformed": { operationId: "missing-fields" } })).rejects.toThrow("native_tool_receipt_invalid");

    const malformedKey = "persisted-null-jsonb";
    await db.execute(sql`INSERT INTO native_tool_receipts (company_id, issue_id, run_id, key_sha256, idempotency_key, receipt)
      VALUES (${owner.companyId}::uuid, ${owner.issueId}::uuid, ${owner.runId}::uuid, ${digest(malformedKey)}, ${malformedKey}, 'null'::jsonb)`);
    await expect(readNativeToolReceipt(db, owner, malformedKey)).rejects.toThrow("native_tool_receipt_invalid");
    const sourceCommentId = randomUUID(), attachmentId = randomUUID();
    await insertNativeToolReceipt(db, owner, "malformed-reuse", receipt("reuse_chat_attachment", { sourceCommentId, attachmentId }, null));
    await expect(findNativeToolReceiptReference(db, owner, "attachment-reuse", `${sourceCommentId}/${attachmentId}`)).rejects.toThrow("native_tool_receipt_invalid");
  });

  it("rolls the business mutation and its receipt back in one transaction", async () => {
    const key = "rollback-effect-and-receipt";
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: owner.companyId, issueId: owner.issueId,
      authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "rolled back generated comment" });
    const before = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, owner.issueId)).then(rows => rows[0]?.title);
    await expect(db.transaction(async tx => {
      await tx.update(issues).set({ title: "must roll back" }).where(eq(issues.id, owner.issueId));
      await insertNativeToolReceipt(tx as unknown as Db, owner, key, receipt("report_progress", {}, { commentId }));
      throw new Error("abort business transaction");
    })).rejects.toThrow("abort business transaction");
    const [issue] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, owner.issueId));
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(nativeToolReceipts).where(and(
      eq(nativeToolReceipts.companyId, owner.companyId), eq(nativeToolReceipts.runId, owner.runId), eq(nativeToolReceipts.idempotencyKey, key),
    ));
    const [comment] = await db.select({ nativeToolGenerated: issueComments.nativeToolGenerated }).from(issueComments).where(eq(issueComments.id, commentId));
    expect(issue?.title).toBe(before);
    expect(count?.count).toBe(0);
    expect(comment?.nativeToolGenerated).toBe(false);
  });

  it("keeps indexed publication, reuse, and comment references available after later receipts without tenant leakage", async () => {
    const publicationId = randomUUID();
    const reusePublicationId = randomUUID();
    const commentId = randomUUID();
    const progressCommentId = randomUUID();
    const crossRunCommentId = randomUUID();
    const malformedReceiptCommentId = randomUUID();
    const sourceCommentId = randomUUID();
    const attachmentId = randomUUID();
    const crossRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: crossRunId, companyId: owner.companyId, agentId: owner.agentId,
      status: "succeeded", runtimeMode: "native", nativeIssueId: owner.issueId, invocationSource: "assignment", triggerDetail: "system" });
    await db.insert(issueComments).values([
      { id: commentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "generated comment" },
      { id: progressCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "progress comment" },
      { id: crossRunCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: crossRunId, body: "comment from another run" },
      { id: malformedReceiptCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "not generated by a valid receipt" },
    ]);
    const publication = receipt("register_deliverable", {}, {
      attachmentId: publicationId, commandId: `deliverable-prepared:${publicationId}`, disposition: "applied", entityRefs: [publicationId],
    });
    const reuse = receipt("reuse_chat_attachment", { sourceCommentId, attachmentId }, {
      commandId: `chat-attachment-reused:${reusePublicationId}`, disposition: "duplicate",
      entityRefs: [reusePublicationId, commentId, crossRunCommentId],
      prepared: { attachmentId: reusePublicationId, commentId },
    });
    const progress = receipt("report_progress", {}, { commentId: progressCommentId });
    const malformed = receipt("register_deliverable", {}, {
      attachmentId: reusePublicationId, commandId: "wrong-command", disposition: "applied",
      entityRefs: [reusePublicationId, malformedReceiptCommentId],
    });
    await insertNativeToolReceipt(db, owner, "indexed-publication", publication);
    await insertNativeToolReceipt(db, owner, "indexed-reuse", reuse);
    await insertNativeToolReceipt(db, owner, "indexed-comment", progress);
    await insertNativeToolReceipt(db, owner, "indexed-malformed-publication", malformed);
    await insertNativeToolReceipt(db, other, "same-target-other-tenant", receipt("register_deliverable", {}, {
      attachmentId: publicationId, commandId: `deliverable-prepared:${publicationId}`, disposition: "applied", entityRefs: [publicationId],
    }));

    const filler = Array.from({ length: 800 }, (_, index) => ({ ...owner, keySha256: digest(`history-${index}`), idempotencyKey: `history-${index}`, receipt: receipt("ordinary_read", {}, { index }) }));
    for (let offset = 0; offset < filler.length; offset += 250) await db.insert(nativeToolReceipts).values(filler.slice(offset, offset + 250));

    expect(await findNativeToolReceiptReference(db, owner, "publication", publicationId)).toEqual(publication);
    expect(await findNativeToolReceiptReference(db, owner, "publication", reusePublicationId)).toEqual(reuse);
    expect(await findNativeToolReceiptReference(db, owner, "attachment-reuse", `${sourceCommentId}/${attachmentId}`)).toEqual(reuse);
    expect(await findNativeToolReceiptReference(db, owner, "generated-comment", commentId)).toEqual(reuse);
    expect(await findNativeToolReceiptReference(db, owner, "generated-comment", progressCommentId)).toEqual(progress);
    expect(await findNativeToolReceiptReference(db, owner, "generated-comment", crossRunCommentId)).toBeNull();
    expect(await findNativeToolReceiptReference(db, owner, "generated-comment", malformedReceiptCommentId)).toBeNull();
    const [marked] = await db.select({ nativeToolGenerated: issueComments.nativeToolGenerated }).from(issueComments).where(eq(issueComments.id, commentId));
    const [markedProgress] = await db.select({ nativeToolGenerated: issueComments.nativeToolGenerated }).from(issueComments).where(eq(issueComments.id, progressCommentId));
    const [notMarkedCrossRun] = await db.select({ nativeToolGenerated: issueComments.nativeToolGenerated }).from(issueComments).where(eq(issueComments.id, crossRunCommentId));
    const [notMarkedMalformed] = await db.select({ nativeToolGenerated: issueComments.nativeToolGenerated }).from(issueComments).where(eq(issueComments.id, malformedReceiptCommentId));
    expect(marked?.nativeToolGenerated).toBe(true);
    expect(markedProgress?.nativeToolGenerated).toBe(true);
    expect(notMarkedCrossRun?.nativeToolGenerated).toBe(false);
    expect(notMarkedMalformed?.nativeToolGenerated).toBe(false);
    expect(await findNativeToolReceiptReference(db, other, "publication", publicationId)).toEqual(expect.objectContaining({ operationId: "register_deliverable" }));
    expect(await findNativeToolReceiptReference(db, owner, "publication", randomUUID())).toBeNull();
    const [references] = await db.select({ count: sql<number>`count(*)::int` }).from(nativeToolReceiptReferences).where(eq(nativeToolReceiptReferences.companyId, owner.companyId));
    expect(references?.count).toBeGreaterThanOrEqual(4);

    const generatedComments = Array.from({ length: 1_200 }, (_, index) => ({ companyId: owner.companyId, issueId: owner.issueId,
      authorAgentId: owner.agentId, createdByRunId: owner.runId, nativeToolGenerated: true, body: `generated-${index}` }));
    for (let offset = 0; offset < generatedComments.length; offset += 300) await db.insert(issueComments).values(generatedComments.slice(offset, offset + 300));
    await db.execute(sql`ANALYZE issue_comments`);
    const plan = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN SELECT id FROM issue_comments WHERE company_id = ${owner.companyId}::uuid
        AND created_by_run_id = ${owner.runId}::uuid AND issue_id = ${owner.issueId}::uuid AND native_tool_generated = false
        ORDER BY created_at DESC, id DESC LIMIT 1`);
    });
    expect(JSON.stringify(plan)).toContain("issue_comments_native_run_response_idx");
  });

  it("backfills exact large and malformed legacy map values, removes only that map, and preserves the rest of result_json", async () => {
    const key = `legacy-large-${"k".repeat(8_192)}`;
    const targetId = randomUUID();
    const damagedReuseSource = randomUUID(), damagedReuseAttachment = randomUUID();
    const exact = receipt("register_deliverable", { title: "old publication" }, {
      attachmentId: targetId, commandId: `deliverable-prepared:${targetId}`, disposition: "applied", entityRefs: [targetId],
    });
    const generatedCommentId = randomUUID();
    const userCommentId = randomUUID();
    const wrongIssueCommentId = randomUUID();
    const wrongCompanyCommentId = randomUUID();
    const crossRunId = randomUUID();
    const crossRunCommentId = randomUUID();
    const malformedReceiptCommentId = randomUUID();
    const wrongIssueId = randomUUID();
    await db.insert(issues).values({ id: wrongIssueId, companyId: owner.companyId, title: "Different issue", status: "in_progress", workMode: "standard", assigneeAgentId: owner.agentId });
    await db.insert(heartbeatRuns).values({ id: crossRunId, companyId: owner.companyId, agentId: owner.agentId,
      status: "succeeded", runtimeMode: "native", nativeIssueId: owner.issueId, invocationSource: "assignment", triggerDetail: "system" });
    await db.insert(issueComments).values([
      { id: generatedCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "generated by migrated receipt" },
      { id: userCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: null, body: "user or final response" },
      { id: wrongIssueCommentId, companyId: owner.companyId, issueId: wrongIssueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "generated on another issue" },
      { id: wrongCompanyCommentId, companyId: other.companyId, issueId: other.issueId, authorAgentId: other.agentId, createdByRunId: other.runId, body: "generated in another company" },
      { id: crossRunCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: crossRunId, body: "generated by another run" },
      { id: malformedReceiptCommentId, companyId: owner.companyId, issueId: owner.issueId, authorAgentId: owner.agentId, createdByRunId: owner.runId, body: "must remain a final response" },
    ]);
    const semanticToolReceipts = {
      [key]: exact,
      "legacy-generated-comment": receipt("report_progress", {}, { commentId: generatedCommentId }),
      "legacy-user-comment": receipt("report_progress", {}, { commentId: userCommentId }),
      "legacy-wrong-issue-comment": receipt("report_progress", {}, { commentId: wrongIssueCommentId }),
      "legacy-wrong-company-comment": receipt("report_progress", {}, { commentId: wrongCompanyCommentId }),
      "legacy-cross-run-comment": receipt("report_progress", {}, { commentId: crossRunCommentId }),
      "legacy-malformed-publication": receipt("register_deliverable", {}, {
        attachmentId: targetId, commandId: "wrong-command", disposition: "applied", entityRefs: [targetId, malformedReceiptCommentId],
      }),
      "malformed-null": null,
      "legacy-damaged-reuse": receipt("reuse_chat_attachment", { sourceCommentId: damagedReuseSource, attachmentId: damagedReuseAttachment }, null),
    };
    await db.update(heartbeatRuns).set({ resultJson: { keep: { marker: "preserved" }, semanticToolReceipts } }).where(eq(heartbeatRuns.id, owner.runId));

    await db.execute(sql.raw("DROP TABLE native_tool_receipt_references, native_tool_receipts CASCADE"));
    const migration = await readFile(resolve(import.meta.dirname, "../../../../packages/db/src/migrations/0300_mushy_sunfire.sql"), "utf8");
    await db.transaction(async tx => {
      for (const statement of migration.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean)) {
        await tx.execute(sql.raw(statement));
      }
    });

    // Re-run the actual follow-up migration from its pre-0301 schema state.
    await db.execute(sql.raw("DROP INDEX IF EXISTS issue_comments_native_run_response_idx"));
    await db.execute(sql.raw("ALTER TABLE issue_comments DROP COLUMN native_tool_generated"));
    const generatedCommentMigration = await readFile(resolve(import.meta.dirname, "../../../../packages/db/src/migrations/0301_petite_photon.sql"), "utf8");
    await db.transaction(async tx => {
      for (const statement of generatedCommentMigration.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean)) {
        await tx.execute(sql.raw(statement));
      }
    });

    expect(await readNativeToolReceipt(db, owner, key)).toEqual(exact);
    await expect(readNativeToolReceipt(db, owner, "malformed-null")).rejects.toThrow("native_tool_receipt_invalid");
    await expect(findNativeToolReceiptReference(db, owner, "attachment-reuse", `${damagedReuseSource}/${damagedReuseAttachment}`)).rejects.toThrow("native_tool_receipt_invalid");
    expect(await findNativeToolReceiptReference(db, owner, "publication", targetId)).toEqual(exact);
    const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run?.resultJson).toEqual({ keep: { marker: "preserved" } });
    const flags = await db.select({ id: issueComments.id, generated: issueComments.nativeToolGenerated }).from(issueComments)
      .where(sql`${issueComments.id} IN (${generatedCommentId}::uuid, ${userCommentId}::uuid, ${wrongIssueCommentId}::uuid, ${wrongCompanyCommentId}::uuid, ${crossRunCommentId}::uuid, ${malformedReceiptCommentId}::uuid)`);
    expect(Object.fromEntries(flags.map(({ id, generated }) => [id, generated]))).toEqual({
      [generatedCommentId]: true,
      [userCommentId]: false,
      [wrongIssueCommentId]: false,
      [wrongCompanyCommentId]: false,
      [crossRunCommentId]: false,
      [malformedReceiptCommentId]: false,
    });
    const [index] = await db.select({ indexname: sql<string>`indexname` }).from(sql`pg_indexes`).where(sql`indexname = 'issue_comments_native_run_response_idx'`);
    expect(index?.indexname).toBe("issue_comments_native_run_response_idx");
  });
});
