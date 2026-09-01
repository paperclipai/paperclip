import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueReferenceService } from "../services/issue-references.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueReferenceMentionsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_reference_mentions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "source_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
      "target_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
      "source_kind" text NOT NULL,
      "source_record_id" uuid,
      "document_key" text,
      "matched_text" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_source_issue_idx"
      ON "issue_reference_mentions" ("company_id", "source_issue_id");
    CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_target_issue_idx"
      ON "issue_reference_mentions" ("company_id", "target_issue_id");
    CREATE INDEX IF NOT EXISTS "issue_reference_mentions_company_issue_pair_idx"
      ON "issue_reference_mentions" ("company_id", "source_issue_id", "target_issue_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "issue_reference_mentions_company_source_mention_uq"
      ON "issue_reference_mentions" ("company_id", "source_issue_id", "target_issue_id", "source_kind", "source_record_id");
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue reference tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueReferenceService", () => {
  let db!: ReturnType<typeof createDb>;
  let refs!: ReturnType<typeof issueReferenceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-refs-");
    db = createDb(tempDb.connectionString);
    refs = issueReferenceService(db);
    await ensureIssueReferenceMentionsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("tracks outbound and inbound references across issue fields, comments, and documents", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetTwoId = randomUUID();
    const targetThreeId = randomUUID();
    const inboundIssueId = randomUUID();
    const commentId = randomUUID();
    const documentId = randomUUID();
    const issueDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Coordinate PAP-2",
        description: "Review /issues/pap-3 and ignore PAP-1 self references.",
        status: "todo",
        priority: "medium",
        identifier: "PAP-1",
      },
      {
        id: targetTwoId,
        companyId,
        title: "Target two",
        status: "todo",
        priority: "medium",
        identifier: "PAP-2",
      },
      {
        id: targetThreeId,
        companyId,
        title: "Target three",
        status: "todo",
        priority: "medium",
        identifier: "PAP-3",
      },
      {
        id: inboundIssueId,
        companyId,
        title: "Inbound reference",
        description: "This one depends on PAP-1.",
        status: "in_progress",
        priority: "high",
        identifier: "PAP-4",
      },
    ]);

    await refs.syncIssue(sourceIssueId);
    await refs.syncIssue(inboundIssueId);

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: sourceIssueId,
      body: "Follow up in https://paperclip.test/issues/pap-2 after the document lands.",
    });
    await refs.syncComment(commentId);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Spec note: /PAP/issues/PAP-3",
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      id: issueDocumentId,
      companyId,
      issueId: sourceIssueId,
      documentId,
      key: "plan",
    });
    await refs.syncDocument(documentId);

    const summary = await refs.listIssueReferenceSummary(sourceIssueId);

    expect(summary.outbound.map((item) => item.issue.identifier)).toEqual(["PAP-2", "PAP-3"]);
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["title", "comment"]);
    expect(summary.outbound[1]?.mentionCount).toBe(2);
    expect(summary.outbound[1]?.sources.map((source) => source.label)).toEqual(["description", "plan"]);
    expect(summary.inbound.map((item) => item.issue.identifier)).toEqual(["PAP-4"]);

    await refs.deleteDocumentSource(documentId);

    const withoutDocument = await refs.listIssueReferenceSummary(sourceIssueId);
    const pap3 = withoutDocument.outbound.find((item) => item.issue.identifier === "PAP-3");

    expect(pap3?.mentionCount).toBe(1);
    expect(pap3?.sources.map((source) => source.label)).toEqual(["description"]);
  });

  it("backfills existing references for a company without requiring write-time sync", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const commentId = randomUUID();
    const documentId = randomUUID();
    const issueDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Backfill",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Legacy issue",
        status: "todo",
        priority: "medium",
        identifier: "PAP-10",
      },
      {
        id: targetIssueId,
        companyId,
        title: "Referenced legacy issue",
        status: "todo",
        priority: "medium",
        identifier: "PAP-20",
      },
    ]);

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: sourceIssueId,
      body: "Legacy comment points at PAP-20.",
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Legacy plan",
      format: "markdown",
      latestBody: "Legacy plan also links /issues/PAP-20.",
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      id: issueDocumentId,
      companyId,
      issueId: sourceIssueId,
      documentId,
      key: "plan",
    });

    await refs.syncAllForCompany(companyId);

    const summary = await refs.listIssueReferenceSummary(sourceIssueId);

    expect(summary.outbound).toHaveLength(1);
    expect(summary.outbound[0]?.issue.identifier).toBe("PAP-20");
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["plan", "comment"]);
  });

  it("rolls back comment reference replacement when insertion fails", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const firstTargetId = randomUUID();
    const secondTargetId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Transaction",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source issue",
        status: "todo",
        priority: "medium",
        identifier: "PAP-1",
      },
      {
        id: firstTargetId,
        companyId,
        title: "First target",
        status: "todo",
        priority: "medium",
        identifier: "PAP-2",
      },
      {
        id: secondTargetId,
        companyId,
        title: "Second target",
        status: "todo",
        priority: "medium",
        identifier: "PAP-3",
      },
    ]);
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: sourceIssueId,
      body: "Initial reference to PAP-2.",
    });
    await refs.syncComment(commentId);
    await db.update(issueComments).set({ body: "Replacement reference to PAP-3." }).where(eq(issueComments.id, commentId));

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION fail_issue_reference_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced issue reference insert failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_issue_reference_insert
        BEFORE INSERT ON "issue_reference_mentions"
        FOR EACH ROW EXECUTE FUNCTION fail_issue_reference_insert();
    `));
    try {
      await expect(refs.syncComment(commentId)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS fail_issue_reference_insert ON "issue_reference_mentions";
        DROP FUNCTION IF EXISTS fail_issue_reference_insert();
      `));
    }

    const mentions = await db.select().from(issueReferenceMentions);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.targetIssueId).toBe(firstTargetId);
  });

  it("suppresses comment reference sync failures through the safe wrapper", async () => {
    await expect(refs.syncCommentSafely(randomUUID())).resolves.toBeUndefined();
  });
});
