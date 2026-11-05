import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, assets, companies, createDb, documentRevisions, documents, heartbeatRuns,
  issueAttachments, issueComments, issueDocuments, issues, issueWorkProducts, taskProviderOutputPolicies,
} from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const bindings = ["native", "legacy", "context-issue", "context-task"] as const;
type Binding = typeof bindings[number];
type Writer = "comment" | "document" | "attachment";
const writers: Writer[] = ["comment", "document", "attachment"];

describePostgres("content writers retain task output provenance", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-content-provenance-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function fixture(binding: Binding = "legacy", restricted = true) {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), targetId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Content provenance", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Content writer", role: "engineer", adapterType: "process" });
    await db.insert(issues).values([
      { id: sourceId, companyId, title: "Source task" },
      { id: targetId, companyId, title: "Ordinary destination" },
    ]);
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: sourceId, disposition: restricted ? "forbidden" : "ordinary" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: targetId, disposition: "ordinary" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "assignment",
      ...(binding === "native" ? { nativeIssueId: sourceId }
        : binding === "legacy" ? { issueId: sourceId }
          : { contextSnapshot: binding === "context-issue" ? { issueId: sourceId } : { taskId: sourceId } }),
    });
    if (binding === "context-issue" || binding === "context-task") {
      await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.id, runId));
    }
    expect(await taskForbidsProviderOutput(db, { companyId, issueId: targetId })).toBe(false);
    return { companyId, agentId, sourceId, targetId, runId };
  }

  function attachmentInput(f: Awaited<ReturnType<typeof fixture>>) {
    return { issueId: f.targetId, provider: "local_disk", objectKey: `synthetic/${randomUUID()}`, contentType: "text/plain",
      byteSize: 24, sha256: "a".repeat(64), originalFilename: "synthetic.txt", createdByAgentId: f.agentId, createdByRunId: f.runId };
  }

  async function write(writer: Writer, f: Awaited<ReturnType<typeof fixture>>, connection = db) {
    if (writer === "attachment") {
      const attachment = await issueService(connection).createAttachment(attachmentInput(f));
      expect(attachment.originatingRunId).toBe(f.runId);
      expect(attachment.artifactWorkProductId).toBeTruthy();
      return attachment.id;
    }
    if (writer === "comment") {
      const comment = await issueService(connection).addComment(f.targetId, "Synthetic source content", { agentId: f.agentId, runId: f.runId });
      expect(comment.createdByRunId).toBe(f.runId);
      return comment.id;
    }
    const result = await documentService(connection).upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown",
      body: "Synthetic source content", createdByAgentId: f.agentId, createdByRunId: f.runId });
    expect((await documentService(connection).listIssueDocumentRevisions(f.targetId, "report"))[0].createdByRunId).toBe(f.runId);
    return result.document.id;
  }

  for (const writer of writers) {
    it.each(bindings)(`${writer} strengthens an existing ordinary destination from a %s run`, async binding => {
      const f = await fixture(binding);
      await write(writer, f);
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
    });

    it(`${writer} keeps ordinary source content usable`, async () => {
      const f = await fixture("legacy", false);
      await write(writer, f);
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
    });

    it(`${writer} retains denial through source deletion and a fresh service instance`, async () => {
      const f = await fixture();
      const id = await write(writer, f);
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.delete(issues).where(eq(issues.id, f.sourceId));
      if (writer === "comment") await issueService(db).removeComment(id);
      else if (writer === "attachment") await issueService(db).removeAttachment(id);
      else await documentService(db).deleteIssueDocument(f.targetId, "report");
      await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.targetId, disposition: "ordinary" });
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
    });

    it(`${writer} rolls back content and disposition together in its caller transaction`, async () => {
      const f = await fixture();
      await expect(db.transaction(async tx => {
        await write(writer, f, tx as unknown as typeof db);
        expect(await taskForbidsProviderOutput(tx, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
        expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
        throw new Error("Caller rolls back");
      })).rejects.toThrow("Caller rolls back");
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetId))).toHaveLength(0);
      expect(await documentService(db).listIssueDocuments(f.targetId)).toHaveLength(0);
      expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, f.targetId))).toHaveLength(0);
      expect(await db.select().from(assets).where(eq(assets.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.targetId))).toHaveLength(0);
    });

    it(`${writer} does not apply another company's restricted run to the destination`, async () => {
      const target = await fixture("legacy", false), other = await fixture();
      if (writer === "comment") {
        const comment = await issueService(db).addComment(target.targetId, "Synthetic content", { agentId: target.agentId, runId: other.runId });
        expect(comment.createdByRunId).toBeNull();
      } else if (writer === "attachment") {
        const attachment = await issueService(db).createAttachment({ ...attachmentInput(target), createdByRunId: other.runId });
        expect(attachment.originatingRunId).toBeNull();
        expect(attachment.artifactWorkProductId).toBeNull();
      } else {
        await documentService(db).upsertIssueDocument({ issueId: target.targetId, key: "report", format: "markdown", body: "Synthetic content",
          createdByAgentId: target.agentId, createdByRunId: other.runId });
      }
      expect(await taskForbidsProviderOutput(db, { companyId: target.companyId, issueId: target.targetId })).toBe(false);
      expect(await db.select().from(taskProviderOutputPolicies).where(and(
        eq(taskProviderOutputPolicies.companyId, other.companyId), eq(taskProviderOutputPolicies.issueId, target.targetId),
      ))).toHaveLength(0);
    });

    it(`${writer} keeps a previously forbidden destination restricted on an ordinary write`, async () => {
      const f = await fixture("legacy", false);
      await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.targetId, disposition: "forbidden" });
      await write(writer, f);
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
    });
  }

  it.each(bindings)("new task creation uses the same %s source-run contract", async binding => {
    const f = await fixture(binding);
    const created = await issueService(db).create(f.companyId, { title: "Derived task", actorRunId: f.runId, parentId: null });
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: created.id })).toBe(true);
  });

  it.each(writers)("%s without a source run preserves ordinary work", async writer => {
    const f = await fixture();
    if (writer === "comment") await issueService(db).addComment(f.targetId, "Human-authored content", { userId: "local-board" });
    else if (writer === "attachment") await issueService(db).createAttachment({ ...attachmentInput(f), createdByAgentId: null, createdByRunId: null, createdByUserId: "local-board" });
    else await documentService(db).upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Human-authored content",
      createdByUserId: "local-board" });
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  it("comment retry strengthens provenance before returning its existing receipt", async () => {
    const f = await fixture("legacy", false);
    const firstId = await write("comment", f);
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.sourceId, disposition: "forbidden" });
    expect(await write("comment", f)).toBe(firstId);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetId))).toHaveLength(1);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
  });

  it("a rejected comment attachment rolls back its newly inherited restriction and comment", async () => {
    const f = await fixture();
    await expect(issueService(db).addComment(f.targetId, "Rejected content", { agentId: f.agentId, runId: f.runId },
      { attachmentIds: [randomUUID()] })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  for (const writer of writers) {
    it.each([true, false])(`${writer} uses the canonical native binding when its restriction is %s`, async restricted => {
      const f = await fixture("legacy", !restricted);
      const nativeId = randomUUID();
      await db.insert(issues).values({ id: nativeId, companyId: f.companyId, title: "Canonical source" });
      await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: nativeId, disposition: restricted ? "forbidden" : "ordinary" });
      const nativeRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nativeRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        invocationSource: "assignment", nativeIssueId: nativeId, contextSnapshot: { taskId: f.sourceId } });
      await write(writer, { ...f, runId: nativeRunId });
      expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(restricted);
    });
  }

  it("an attachment with a rejected parent comment leaves no content or restriction", async () => {
    const f = await fixture();
    await expect(issueService(db).createAttachment({ ...attachmentInput(f), issueCommentId: randomUUID() }))
      .rejects.toMatchObject({ status: 404 });
    expect(await issueService(db).listAttachments(f.targetId)).toHaveLength(0);
    expect(await db.select().from(assets).where(eq(assets.companyId, f.companyId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  it("an asset insertion failure rolls back the newly inherited restriction", async () => {
    const f = await fixture();
    const input = attachmentInput(f);
    await db.insert(assets).values({ companyId: f.companyId, provider: input.provider, objectKey: input.objectKey,
      contentType: input.contentType, byteSize: input.byteSize, sha256: input.sha256 });
    await expect(issueService(db).createAttachment(input)).rejects.toThrow();
    expect(await issueService(db).listAttachments(f.targetId)).toHaveLength(0);
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.targetId))).toHaveLength(0);
    expect(await db.select().from(assets).where(eq(assets.companyId, f.companyId))).toHaveLength(1);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  it("an attachment does not inherit from a run rejected by the existing agent binding", async () => {
    const f = await fixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Other writer", role: "engineer", adapterType: "process" });
    const attachment = await issueService(db).createAttachment({ ...attachmentInput(f), createdByAgentId: otherAgentId });
    expect(attachment.originatingRunId).toBeNull();
    expect(attachment.artifactWorkProductId).toBeNull();
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  it.each(["update", "locked-fork"] as const)("document %s inherits before committing content", async mode => {
    const f = await fixture();
    const svc = documentService(db);
    const original = await svc.upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Ordinary draft" });
    if (mode === "locked-fork") await svc.lockIssueDocument({ issueId: f.targetId, key: "report", lockedByUserId: "local-board" });
    const result = await svc.upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Restricted revision",
      baseRevisionId: original.document.latestRevisionId, createdByAgentId: f.agentId, createdByRunId: f.runId,
      ...(mode === "locked-fork" ? { lockedDocumentStrategy: "create_new_document" as const } : {}),
    });
    expect(result.document.body).toBe("Restricted revision");
    expect(result.document.key).toBe(mode === "locked-fork" ? "report-2" : "report");
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(true);
  });

  it("a rejected stale revision does not strengthen the destination or append a revision", async () => {
    const f = await fixture();
    const svc = documentService(db);
    const original = await svc.upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Ordinary draft" });
    await expect(svc.upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Rejected content",
      baseRevisionId: randomUUID(), createdByAgentId: f.agentId, createdByRunId: f.runId })).rejects.toMatchObject({ status: 409 });
    expect(await svc.getIssueDocumentByKey(f.targetId, "report")).toMatchObject({ body: "Ordinary draft", latestRevisionId: original.document.latestRevisionId });
    expect(await svc.listIssueDocumentRevisions(f.targetId, "report")).toHaveLength(1);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });

  it("a failed document creation does not leave provenance or partial content", async () => {
    const f = await fixture();
    await expect(documentService(db).upsertIssueDocument({ issueId: f.targetId, key: "report", format: "markdown", body: "Rejected content",
      baseRevisionId: randomUUID(), createdByAgentId: f.agentId, createdByRunId: f.runId })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, f.targetId))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.companyId, f.companyId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, { companyId: f.companyId, issueId: f.targetId })).toBe(false);
  });
});
