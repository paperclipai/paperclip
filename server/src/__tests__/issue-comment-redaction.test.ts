import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issueComments,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import { companySearchQuerySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { companySearchService } from "../services/company-search.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { issueReferenceService } from "../services/issue-references.js";
import { issueService } from "../services/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comment redaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("deleted issue comment redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-redaction-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Comment Redaction Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RED-1",
      title: "Deleted comment redaction",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  it("redacts deleted comment bodies from ordinary reads, heartbeat context, and wake payloads", async () => {
    const { companyId, issueId } = await seedIssue();
    const commentId = randomUUID();
    const deletedAt = new Date("2026-06-03T12:00:00.000Z");
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-user-1",
      body: "secret deleted body",
      presentation: { kind: "system_notice", tone: "warning" },
      metadata: { version: 1, sections: [{ rows: [{ type: "text", text: "secret metadata" }] }] },
      deletedAt,
      deletedByType: "user",
      deletedByUserId: "board-user-1",
    });

    const comments = await issueService(db).listComments(issueId, { order: "asc" });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: commentId,
      body: "",
      presentation: null,
      metadata: null,
      deletedAt,
      deletedByType: "user",
      deletedByUserId: "board-user-1",
    });

    const exactComment = await issueService(db).getComment(commentId);
    expect(exactComment?.body).toBe("");
    expect(exactComment?.metadata).toBeNull();

    const heartbeatContext = await request(createApp(companyId))
      .get(`/api/issues/${issueId}/heartbeat-context`)
      .query({ wakeCommentId: commentId });
    expect(heartbeatContext.status, JSON.stringify(heartbeatContext.body)).toBe(200);
    expect(heartbeatContext.body.wakeComment).toMatchObject({
      id: commentId,
      body: "",
      metadata: null,
      deletedByUserId: "board-user-1",
    });
    expect(JSON.stringify(heartbeatContext.body)).not.toContain("secret deleted body");
    expect(JSON.stringify(heartbeatContext.body)).not.toContain("secret metadata");

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        commentId,
        wakeCommentIds: [commentId],
        wakeReason: "issue_commented",
      },
    });

    expect(wakePayload?.comments).toEqual([
      expect.objectContaining({
        id: commentId,
        body: "",
        bodyTruncated: false,
        presentation: null,
        metadata: null,
        deletedAt: deletedAt.toISOString(),
        deletedByUserId: "board-user-1",
      }),
    ]);
    expect(JSON.stringify(wakePayload)).not.toContain("secret deleted body");
    expect(JSON.stringify(wakePayload)).not.toContain("secret metadata");
  });

  it("adds recent issue comments to accepted-plan continuation wake payloads", async () => {
    const { companyId, issueId } = await seedIssue();
    const firstCommentId = randomUUID();
    const secondCommentId = randomUUID();
    const deletedCommentId = randomUUID();
    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        authorUserId: "board-user-1",
        body: "Keep the migration backwards compatible.",
        createdAt: new Date("2026-06-03T12:00:00.000Z"),
      },
      {
        id: deletedCommentId,
        companyId,
        issueId,
        authorUserId: "board-user-1",
        body: "Do not pass this deleted text downstream.",
        deletedAt: new Date("2026-06-03T12:01:00.000Z"),
        deletedByType: "user",
        deletedByUserId: "board-user-1",
        createdAt: new Date("2026-06-03T12:01:00.000Z"),
      },
      {
        id: secondCommentId,
        companyId,
        issueId,
        authorUserId: "board-user-1",
        body: "Split the rollout into a verification child task.",
        createdAt: new Date("2026-06-03T12:02:00.000Z"),
      },
    ]);

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        workspaceRefreshReason: "accepted_plan_confirmation",
      },
      issueSummary: {
        id: issueId,
        identifier: "RED-1",
        title: "Deleted comment redaction",
        status: "in_progress",
        priority: "medium",
        workMode: "planning",
      },
    });

    expect(wakePayload?.commentContextSource).toBe("accepted_plan_confirmation");
    expect(wakePayload?.commentIds).toEqual([firstCommentId, secondCommentId]);
    expect(wakePayload?.comments.map((comment) => comment.body)).toEqual([
      "Keep the migration backwards compatible.",
      "Split the rollout into a verification child task.",
    ]);
    expect(JSON.stringify(wakePayload)).not.toContain("Do not pass this deleted text downstream.");
  });

  it("excludes deleted comment bodies from company search", async () => {
    const { companyId, issueId } = await seedIssue();
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "vanished-search-needle",
      deletedAt: new Date("2026-06-03T12:00:00.000Z"),
      deletedByType: "user",
      deletedByUserId: "board-user-1",
    });

    const result = await companySearchService(db).search(
      companyId,
      companySearchQuerySchema.parse({ q: "vanished-search-needle", scope: "comments" }),
    );

    expect(result.results).toEqual([]);
  });

  it("clears issue references sourced from deleted comment bodies", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reference Redaction Co",
      issuePrefix: "REF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        identifier: "REF-1",
        title: "Source issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: targetIssueId,
        companyId,
        identifier: "REF-2",
        title: "Target issue",
        status: "todo",
        priority: "medium",
      },
    ]);
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: sourceIssueId,
      body: "Follow up in REF-2",
    });

    const refs = issueReferenceService(db);
    await refs.syncComment(commentId);
    expect((await refs.listIssueReferenceSummary(sourceIssueId)).outbound.map((item) => item.issue.id)).toEqual([
      targetIssueId,
    ]);

    await db.update(issueComments).set({
      deletedAt: new Date("2026-06-03T12:00:00.000Z"),
      deletedByType: "user",
      deletedByUserId: "board-user-1",
    });
    await refs.syncComment(commentId);

    expect((await refs.listIssueReferenceSummary(sourceIssueId)).outbound).toEqual([]);
  });
});
