import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  assets,
  companies,
  createDb,
  issues,
  issueAttachments,
  reviewedArtifactItems,
  reviewedArtifactSets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reviewedArtifactService } from "../services/reviewed-artifacts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reviewed artifact service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("reviewedArtifactService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof reviewedArtifactService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reviewed-artifacts-");
    db = createDb(tempDb.connectionString);
    svc = reviewedArtifactService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(reviewedArtifactItems);
    await db.delete(reviewedArtifactSets);
    await db.delete(approvals);
    await db.delete(issueAttachments);
    await db.delete(issues);
    await db.delete(assets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists stable ordered items for approval reviewed artifacts", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prepare approval",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { summary: "Approve this" },
    });

    const created = await svc.createSet({
      companyId,
      context: { type: "approval", approvalId, issueId },
      title: "Approval packet",
      items: [
        {
          source: { type: "external_url", url: "https://example.com/preview" },
          title: "Preview",
          displayHint: "link",
          selectedExplicitly: true,
        },
        {
          source: { type: "approval_payload", pointer: "/summary" },
          title: "Approval summary",
          displayHint: "json",
          isPrimary: true,
          required: true,
        },
      ],
    });

    expect(created.contextType).toBe("approval");
    expect(created.approvalId).toBe(approvalId);
    expect(created.contextIssueId).toBe(issueId);
    expect(created.items.map((item) => item.orderIndex)).toEqual([0, 1]);
    expect(created.items.map((item) => item.title)).toEqual(["Preview", "Approval summary"]);
    expect(created.items[0].source).toEqual({ type: "external_url", url: "https://example.com/preview" });
    expect(created.items[1]).toEqual(expect.objectContaining({
      source: { type: "approval_payload", pointer: "/summary" },
      isPrimary: true,
      required: true,
      displayHint: "json",
    }));

    const active = await svc.getActiveForApproval(companyId, approvalId);
    expect(active?.id).toBe(created.id);
    expect(active?.items.map((item) => item.title)).toEqual(["Preview", "Approval summary"]);
  });

  it("supersedes prior active explicit issue review sets without mutating historical items", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Submit for review",
      status: "in_review",
      priority: "medium",
    });

    const first = await svc.createSet({
      companyId,
      context: { type: "issue_review", issueId },
      items: [
        {
          source: { type: "issue_document", issueId, documentKey: "plan" },
          title: "Original plan",
          displayHint: "markdown",
        },
      ],
    });
    const second = await svc.createSet({
      companyId,
      context: { type: "issue_review", issueId },
      items: [
        {
          source: { type: "external_url", url: "https://example.com/revised" },
          title: "Revised preview",
          displayHint: "link",
        },
      ],
    });

    const active = await svc.getActiveForIssueReview(companyId, issueId);
    const historical = await svc.getById(first.id);

    expect(active?.id).toBe(second.id);
    expect(historical?.supersededBySetId).toBe(second.id);
    expect(historical?.supersededAt).toBeInstanceOf(Date);
    expect(historical?.items).toHaveLength(1);
    expect(historical?.items[0].title).toBe("Original plan");
    expect(historical?.items[0].source).toEqual({ type: "issue_document", issueId, documentKey: "plan", revisionId: null });
  });

  it("resolves nulled required source references as unresolved artifacts", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const assetId = randomUUID();
    const attachmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review attachment",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local",
      objectKey: `test/${assetId}`,
      contentType: "text/markdown",
      byteSize: 12,
      sha256: "test-sha",
      originalFilename: "review.md",
    });
    await db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
    });

    const created = await svc.createSet({
      companyId,
      context: { type: "issue_review", issueId },
      items: [
        {
          source: { type: "issue_attachment", issueId, attachmentId },
          title: "Review attachment",
          required: true,
        },
      ],
    });

    await db.delete(issueAttachments).where(eq(issueAttachments.id, attachmentId));

    const resolved = await svc.getById(created.id);

    expect(resolved?.items).toHaveLength(1);
    expect(resolved?.items[0]).toEqual(expect.objectContaining({
      sourceType: "issue_attachment",
      title: "Review attachment",
      required: true,
      source: {
        type: "unresolved",
        originalType: "issue_attachment",
        reason: "missing_source_reference",
        missingFields: ["sourceIssueAttachmentId"],
      },
    }));
  });

  it("rejects workspace file writer input while keeping the source type modeled", async () => {
    const issueId = randomUUID();

    await expect(svc.createSet({
      companyId: randomUUID(),
      context: { type: "issue_review", issueId },
      items: [
        {
          source: {
            type: "workspace_file",
            issueId,
            executionWorkspaceId: randomUUID(),
            path: "dist/report.md",
          },
          title: "Workspace file",
        } as any,
      ],
    })).rejects.toThrow();
  });

  it("keeps existing reviews and approvals valid without migration backfill rows", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy review",
      status: "in_review",
      priority: "medium",
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { summary: "Legacy approval" },
    });

    await expect(svc.getActiveForIssueReview(companyId, issueId)).resolves.toBeNull();
    await expect(svc.getActiveForApproval(companyId, approvalId)).resolves.toBeNull();

    const [sets, items] = await Promise.all([
      db.select().from(reviewedArtifactSets),
      db.select().from(reviewedArtifactItems),
    ]);
    expect(sets).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});
