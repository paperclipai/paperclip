import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService system issue documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let issueSvc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
    issueSvc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssueWithDocuments() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1600",
      title: "System document filtering",
      description: "Validate document filtering",
      status: "in_progress",
      priority: "medium",
    });

    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan",
    });
    await svc.upsertIssueDocument({
      issueId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Handoff",
    });

    return { issueId };
  }

  async function issueVersion(issueId: string) {
    return db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.version);
  }

  async function withDelayedRowTrigger<T>(
    triggerName: string,
    tableName: "documents" | "issue_documents",
    operation: "INSERT" | "UPDATE" | "DELETE",
    callback: () => Promise<T>,
    delaySeconds = 0.2,
  ): Promise<T> {
    const functionName = `${triggerName}_fn`;
    await db.execute(sql.raw(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(${delaySeconds});
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER "${triggerName}"
      BEFORE ${operation} ON "${tableName}"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `));
    try {
      return await callback();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableName}"`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`));
    }
  }

  async function waitForSleepingDocumentUpdate() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ sleeping: number | string }>`
        SELECT count(*)::int AS sleeping
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Timeout'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%update "documents"%'
      `));
      if (Number(rows[0]?.sleeping ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for sleeping document update");
  }

  async function waitForSleepingDocumentInsert() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ sleeping: number | string }>`
        SELECT count(*)::int AS sleeping
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Timeout'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%insert into "documents"%'
      `));
      if (Number(rows[0]?.sleeping ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for sleeping document insert");
  }

  it("filters continuation summaries from default document lists and issue payload summaries", async () => {
    const { issueId } = await createIssueWithDocuments();
    expect(await issueVersion(issueId)).toBe(3);

    const defaultDocuments = await svc.listIssueDocuments(issueId);
    expect(defaultDocuments.map((doc) => doc.key)).toEqual(["plan"]);

    const payload = await svc.getIssueDocumentPayload({ id: issueId, description: null });
    expect(payload.planDocument?.key).toBe("plan");
    expect(payload.documentSummaries.map((doc) => doc.key)).toEqual(["plan"]);
  });

  it("keeps system documents available for includeSystem and direct fetch callers", async () => {
    const { issueId } = await createIssueWithDocuments();

    const debugDocuments = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(debugDocuments.map((doc) => doc.key)).toEqual([
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      "plan",
    ]);

    const directHandoff = await svc.getIssueDocumentByKey(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);
    expect(directHandoff).toEqual(expect.objectContaining({
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      body: "# Handoff",
    }));
  });

  it("locks and unlocks issue documents", async () => {
    const { issueId } = await createIssueWithDocuments();
    expect(await issueVersion(issueId)).toBe(3);

    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);
    expect(locked.document.lockedByUserId).toBe("board-user");
    expect(await issueVersion(issueId)).toBe(4);

    const unchangedLock = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });
    expect(unchangedLock.changed).toBe(false);
    expect(await issueVersion(issueId)).toBe(4);

    await expect(svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: locked.document.latestRevisionId,
      createdByUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Document is locked",
    });
    expect(await issueVersion(issueId)).toBe(4);

    const unlocked = await svc.unlockIssueDocument(issueId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();
    expect(await issueVersion(issueId)).toBe(5);

    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: unlocked.document.latestRevisionId,
      createdByUserId: "board-user",
    });

    expect(updated.created).toBe(false);
    expect(updated.document.body).toBe("# Updated plan");
    expect(await issueVersion(issueId)).toBe(6);
  });

  it("serializes concurrent document locks into one aggregate mutation", async () => {
    const { issueId } = await createIssueWithDocuments();

    const results = await withDelayedRowTrigger(
      "delay_concurrent_document_lock",
      "documents",
      "UPDATE",
      async () =>
        await Promise.all([
          svc.lockIssueDocument({ issueId, key: "plan", lockedByUserId: "first-user" }),
          svc.lockIssueDocument({ issueId, key: "plan", lockedByUserId: "second-user" }),
        ]),
    );

    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(await issueVersion(issueId)).toBe(4);
  });

  it("serializes concurrent document unlocks into one aggregate mutation", async () => {
    const { issueId } = await createIssueWithDocuments();
    await svc.lockIssueDocument({ issueId, key: "plan", lockedByUserId: "board-user" });

    const results = await withDelayedRowTrigger(
      "delay_concurrent_document_unlock",
      "documents",
      "UPDATE",
      async () =>
        await Promise.all([
          svc.unlockIssueDocument(issueId, "plan"),
          svc.unlockIssueDocument(issueId, "plan"),
        ]),
    );

    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(await issueVersion(issueId)).toBe(5);
  });

  it("serializes concurrent document deletes into one aggregate mutation", async () => {
    const { issueId } = await createIssueWithDocuments();

    const results = await withDelayedRowTrigger(
      "delay_concurrent_document_delete",
      "issue_documents",
      "DELETE",
      async () =>
        await Promise.all([
          svc.deleteIssueDocument(issueId, "plan"),
          svc.deleteIssueDocument(issueId, "plan"),
        ]),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await issueVersion(issueId)).toBe(4);
  });

  it("avoids deadlock between document update and lock", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    if (!plan?.latestRevisionId) throw new Error("Expected the plan to have an initial revision");

    const results = await withDelayedRowTrigger(
      "delay_cross_document_update",
      "documents",
      "UPDATE",
      async () => {
        const update = svc.upsertIssueDocument({
          issueId,
          key: "plan",
          title: "Plan",
          format: "markdown",
          body: "# Updated before lock",
          baseRevisionId: plan.latestRevisionId,
          createdByUserId: "board-user",
        });
        await waitForSleepingDocumentUpdate();
        const lock = svc.lockIssueDocument({
          issueId,
          key: "plan",
          lockedByUserId: "board-user",
        });
        return await Promise.all([update, lock]);
      },
      1.5,
    );

    expect(results[0].created).toBe(false);
    expect(results[1].changed).toBe(true);
    expect(await issueVersion(issueId)).toBe(5);
  }, 15_000);

  it("avoids deadlock between document restore and delete", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    if (!plan?.latestRevisionId) throw new Error("Expected the plan to have an initial revision");
    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: plan.latestRevisionId,
      createdByUserId: "board-user",
    });

    const results = await withDelayedRowTrigger(
      "delay_cross_document_restore",
      "documents",
      "UPDATE",
      async () => {
        const restore = svc.restoreIssueDocumentRevision({
          issueId,
          key: "plan",
          revisionId: plan.latestRevisionId,
          createdByUserId: "board-user",
        });
        await waitForSleepingDocumentUpdate();
        const deletion = svc.deleteIssueDocument(issueId, "plan");
        return await Promise.all([restore, deletion]);
      },
      1.5,
    );

    expect(results[0].restoredFromRevisionId).toBe(plan.latestRevisionId);
    expect(results[1]).not.toBeNull();
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toBeNull();
    expect(await issueVersion(issueId)).toBe(6);
  }, 15_000);

  it("avoids deadlock between document update and issue removal", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    if (!plan?.latestRevisionId) throw new Error("Expected the plan to have an initial revision");

    const [updated, removed] = await withDelayedRowTrigger(
      "delay_document_update_before_issue_removal",
      "documents",
      "UPDATE",
      async () => {
        const update = svc.upsertIssueDocument({
          issueId,
          key: "plan",
          title: "Plan",
          format: "markdown",
          body: "# Updated before issue removal",
          baseRevisionId: plan.latestRevisionId,
          createdByUserId: "board-user",
        });
        await waitForSleepingDocumentUpdate();
        const removal = issueSvc.remove(issueId);
        return await Promise.all([update, removal]);
      },
      1.5,
    );

    expect(updated.created).toBe(false);
    expect(removed).not.toBeNull();
    await expect(svc.getIssueDocumentByKey(issueId, "plan")).resolves.toBeNull();
    await expect(issueVersion(issueId)).resolves.toBeUndefined();
  }, 15_000);

  it("does not orphan a document created while its issue is removed", async () => {
    const { issueId } = await createIssueWithDocuments();

    const [created, removed] = await withDelayedRowTrigger(
      "delay_document_create_before_issue_removal",
      "documents",
      "INSERT",
      async () => {
        const creation = svc.upsertIssueDocument({
          issueId,
          key: "notes",
          title: "Notes",
          format: "markdown",
          body: "# Notes",
          createdByUserId: "board-user",
        });
        await waitForSleepingDocumentInsert();
        const removal = issueSvc.remove(issueId);
        return await Promise.all([creation, removal]);
      },
      1.5,
    );

    expect(created.created).toBe(true);
    expect(removed).not.toBeNull();
    await expect(
      db.select({ id: documents.id }).from(documents).where(eq(documents.id, created.document.id)),
    ).resolves.toEqual([]);
  }, 15_000);

  it("creates a new document instead of updating a locked document when requested", async () => {
    const { issueId } = await createIssueWithDocuments();
    expect(await issueVersion(issueId)).toBe(3);
    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });
    expect(await issueVersion(issueId)).toBe(4);

    const fallback = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Agent replacement plan",
      baseRevisionId: locked.document.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    });

    expect(fallback.created).toBe(true);
    expect(fallback.document.key).toBe("plan-2");
    expect(fallback.document.body).toBe("# Agent replacement plan");
    expect("redirectedFromLockedDocument" in fallback ? fallback.redirectedFromLockedDocument : null)
      .toEqual({ id: locked.document.id, key: "plan" });
    expect(await issueVersion(issueId)).toBe(5);

    const originalPlan = await svc.getIssueDocumentByKey(issueId, "plan");
    expect(originalPlan).toEqual(expect.objectContaining({
      body: "# Plan",
      lockedAt: expect.any(Date),
    }));

    const newPlan = await svc.getIssueDocumentByKey(issueId, "plan-2");
    expect(newPlan).toEqual(expect.objectContaining({
      body: "# Agent replacement plan",
      lockedAt: null,
    }));
  });

  it("advances the issue version for document restore and delete mutations", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    const originalRevisionId = plan?.latestRevisionId;
    expect(originalRevisionId).toBeTruthy();
    if (!originalRevisionId) throw new Error("Expected the plan to have an initial revision");

    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: originalRevisionId,
      createdByUserId: "board-user",
    });
    expect(updated.created).toBe(false);
    expect(await issueVersion(issueId)).toBe(4);

    await svc.restoreIssueDocumentRevision({
      issueId,
      key: "plan",
      revisionId: originalRevisionId,
      createdByUserId: "board-user",
    });
    expect(await issueVersion(issueId)).toBe(5);

    await expect(svc.deleteIssueDocument(issueId, "plan")).resolves.not.toBeNull();
    expect(await issueVersion(issueId)).toBe(6);

    await expect(svc.deleteIssueDocument(issueId, "plan")).resolves.toBeNull();
    expect(await issueVersion(issueId)).toBe(6);
  });
});
