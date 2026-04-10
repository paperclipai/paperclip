import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  artifacts as artifactTable,
  companies,
  createDb,
  documents,
  documentRevisions,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { clearArtifactCreatedHandlers } from "../services/artifact-events.ts";
import { artifactService } from "../services/artifacts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping artifact service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("artifactService.ensureApprovedSnapshotsForIssueDocuments", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof artifactService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempPaperclipHome = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifacts-service-");
    db = createDb(tempDb.connectionString);
    svc = artifactService(db);
  }, 20_000);

  beforeEach(() => {
    tempPaperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-artifacts-home-"));
    process.env.PAPERCLIP_HOME = tempPaperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    clearArtifactCreatedHandlers();
  });

  afterEach(async () => {
    clearArtifactCreatedHandlers();
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    if (tempPaperclipHome) {
      fs.rmSync(tempPaperclipHome, { recursive: true, force: true });
      tempPaperclipHome = "";
    }

    await db.delete(activityLog);
    await db.delete(artifactTable);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueDocument(body: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-04-10T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Artifacts Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Approved review doc",
      description: "Review document fixture",
      status: "in_review",
      priority: "medium",
      createdByUserId: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Review Plan",
      format: "markdown",
      latestBody: body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Review Plan",
      format: "markdown",
      body,
      createdByUserId: "user-1",
      createdAt: now,
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "review",
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, issueId, documentId };
  }

  async function seedIssueWithoutDocuments(description: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-04-10T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Artifacts Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Approval with no documents",
      description,
      status: "in_review",
      priority: "medium",
      createdByUserId: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, issueId };
  }

  function createApprovalContext(input?: {
    approvalId?: string;
    approvedAt?: Date;
  }) {
    return {
      origin: "approval" as const,
      approvalId: input?.approvalId ?? "approval-1",
      originRoute: "/approvals/:id/approve",
      approvedAt: input?.approvedAt ?? new Date("2026-04-10T01:00:00.000Z"),
      approvedBy: {
        type: "user" as const,
        id: "user-1",
      },
    };
  }

  it("creates an immutable artifact and noops when the same approved revision is seen again", async () => {
    const { companyId, issueId } = await seedIssueDocument("# Review\n\n- Freeze this plan");

    const first = await svc.ensureApprovedSnapshotsForIssueDocuments({
      issueId,
      context: createApprovalContext({ approvalId: "approval-1" }),
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.created).toBe(true);
    expect(first[0]?.artifact.version).toBe(1);
    expect(fs.existsSync(first[0]!.artifact.storagePath)).toBe(true);

    const firstContent = await fs.promises.readFile(first[0]!.artifact.storagePath, "utf8");
    expect(firstContent).toContain("# Approved Snapshot: Review Plan");
    expect(firstContent).toContain("## Approved Content");
    expect(firstContent).toContain("- Freeze this plan");

    const second = await svc.ensureApprovedSnapshotsForIssueDocuments({
      issueId,
      context: createApprovalContext({
        approvalId: "approval-2",
        approvedAt: new Date("2026-04-11T01:00:00.000Z"),
      }),
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.created).toBe(false);
    expect(second[0]?.artifact.version).toBe(1);

    const stored = await svc.list(companyId, { sourceType: "issue_document" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.version).toBe(1);
  });

  it("increments the artifact version when the approved document revision changes", async () => {
    const { companyId, issueId, documentId } = await seedIssueDocument("# Review\n\n- Original decision");

    const first = await svc.ensureApprovedSnapshotsForIssueDocuments({
      issueId,
      context: createApprovalContext({ approvalId: "approval-1" }),
    });
    expect(first[0]?.artifact.version).toBe(1);

    const revisionId = randomUUID();
    const updatedAt = new Date("2026-04-12T00:00:00.000Z");
    const updatedBody = "# Review\n\n- Revised approved decision";

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Review Plan",
      format: "markdown",
      body: updatedBody,
      createdByUserId: "user-1",
      createdAt: updatedAt,
    });

    await db
      .update(documents)
      .set({
        latestBody: updatedBody,
        latestRevisionId: revisionId,
        latestRevisionNumber: 2,
        updatedByUserId: "user-1",
        updatedAt,
      })
      .where(eq(documents.id, documentId));

    const second = await svc.ensureApprovedSnapshotsForIssueDocuments({
      issueId,
      context: createApprovalContext({
        approvalId: "approval-2",
        approvedAt: new Date("2026-04-12T01:00:00.000Z"),
      }),
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.created).toBe(true);
    expect(second[0]?.artifact.version).toBe(2);

    const stored = await svc.list(companyId, { sourceType: "issue_document" });
    expect(stored).toHaveLength(2);
    expect(stored.map((artifact) => artifact.version).sort((a, b) => a - b)).toEqual([1, 2]);

    const versionTwo = await db
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.id, second[0]!.artifact.id))
      .then((rows) => rows[0] ?? null);
    expect(versionTwo?.version).toBe(2);

    const snapshot = await fs.promises.readFile(second[0]!.artifact.storagePath, "utf8");
    expect(snapshot).toContain("- Revised approved decision");
  });

  it("does not create vault-exportable artifacts when an issue has no durable documents", async () => {
    const { companyId, issueId } = await seedIssueWithoutDocuments(`## Plan

- This issue body is workflow context only.
- It must not become a vault-exportable artifact.`);

    const results = await svc.ensureApprovedSnapshotsForIssueDocuments({
      issueId,
      context: createApprovalContext({ approvalId: "approval-1" }),
    });

    expect(results).toEqual([]);
    const stored = await svc.list(companyId);
    expect(stored).toEqual([]);
  });
});
