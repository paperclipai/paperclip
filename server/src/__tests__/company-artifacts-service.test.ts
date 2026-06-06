import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { companyArtifactsService } from "../services/company-artifacts.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company artifacts tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createStorageService(files: Record<string, Buffer> = {}): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async (_companyId, objectKey, options) => {
      const body = files[objectKey] ?? Buffer.alloc(0);
      const range = options?.range;
      const ranged = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(ranged),
        contentType: "text/plain",
        contentLength: ranged.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("companyArtifactsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedArtifacts() {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const otherCompanyId = "22222222-2222-4222-8222-222222222222";
    const agentId = "33333333-3333-4333-8333-333333333333";
    const otherAgentId = "44444444-4444-4444-8444-444444444444";
    const projectId = "55555555-5555-4555-8555-555555555555";
    const issueId = "66666666-6666-4666-8666-666666666666";
    const secondIssueId = "77777777-7777-4777-8777-777777777777";
    const otherIssueId = "88888888-8888-4888-8888-888888888888";
    const runId = "99999999-9999-4999-8999-999999999999";
    const otherRunId = "19191919-1919-4191-8191-191919191919";
    const directAttachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workProductAttachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: "PAP", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Coder", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Artifacts", status: "in_progress" });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        projectId,
        identifier: "PAP-1",
        title: "Make the reel",
        status: "done",
        priority: "medium",
      },
      {
        id: secondIssueId,
        companyId,
        identifier: "PAP-2",
        title: "Write the plan",
        status: "done",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId: otherCompanyId,
        identifier: "OTH-1",
        title: "Other output",
        status: "done",
        priority: "medium",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "completed",
      },
      {
        id: otherRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "completed",
      },
    ]);
    await db.insert(documents).values([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        title: "Review Notes",
        latestBody: "# Review\n\nAgent-created review document with useful details.",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        companyId,
        title: "Continuation Summary",
        latestBody: "System handoff",
        createdByAgentId: agentId,
        updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        companyId,
        title: "User Upload Notes",
        latestBody: "User-authored context",
        createdByUserId: "user-1",
        updatedAt: new Date("2026-01-06T00:00:00.000Z"),
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId: otherCompanyId,
        title: "Other Company Plan",
        latestBody: "Must not cross tenants",
        createdByAgentId: otherAgentId,
        updatedAt: new Date("2026-01-07T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: secondIssueId,
        documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        key: "review",
      },
      {
        companyId,
        issueId,
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      },
      {
        companyId,
        issueId,
        documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        key: "user-notes",
      },
      {
        companyId: otherCompanyId,
        issueId: otherIssueId,
        documentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        key: "plan",
      },
    ]);
    await db.insert(issueComments).values({
      id: "12121212-1212-4121-8121-121212121212",
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "comment with screenshot",
    });
    await db.insert(assets).values([
      {
        id: "13131313-1313-4131-8131-131313131313",
        companyId,
        provider: "local_disk",
        objectKey: "direct-video.mp4",
        contentType: "video/mp4",
        byteSize: 100,
        sha256: "sha256-direct-video",
        originalFilename: "direct-video.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "14141414-1414-4141-8141-141414141414",
        companyId,
        provider: "local_disk",
        objectKey: "primary-cut.mp4",
        contentType: "video/mp4",
        byteSize: 200,
        sha256: "sha256-primary-cut",
        originalFilename: "primary-cut.mp4",
        createdByAgentId: agentId,
      },
      {
        id: "15151515-1515-4151-8151-151515151515",
        companyId,
        provider: "local_disk",
        objectKey: "operator-screenshot.png",
        contentType: "image/png",
        byteSize: 300,
        sha256: "sha256-user",
        originalFilename: "operator-screenshot.png",
        createdByUserId: "user-1",
      },
      {
        id: "16161616-1616-4161-8161-161616161616",
        companyId,
        provider: "local_disk",
        objectKey: "comment-screenshot.png",
        contentType: "image/png",
        byteSize: 400,
        sha256: "sha256-comment",
        originalFilename: "comment-screenshot.png",
        createdByAgentId: agentId,
      },
      {
        id: "17171717-1717-4171-8171-171717171717",
        companyId,
        provider: "local_disk",
        objectKey: "notes.txt",
        contentType: "text/plain",
        byteSize: 64,
        sha256: "sha256-notes",
        originalFilename: "notes.txt",
        createdByAgentId: agentId,
      },
    ]);
    await db.insert(issueAttachments).values([
      {
        id: directAttachmentId,
        companyId,
        issueId,
        assetId: "13131313-1313-4131-8131-131313131313",
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: workProductAttachmentId,
        companyId,
        issueId,
        assetId: "14141414-1414-4141-8141-141414141414",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "15151515-1515-4151-8151-151515151515",
        updatedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "16161616-1616-4161-8161-161616161616",
        issueCommentId: "12121212-1212-4121-8121-121212121212",
        updatedAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        assetId: "17171717-1717-4171-8171-171717171717",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueWorkProducts).values({
      id: "18181818-1818-4181-8181-181818181818",
      companyId,
      projectId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Primary Cut",
      status: "ready_for_review",
      summary: "Main render for review",
      isPrimary: true,
      metadata: {
        attachmentId: workProductAttachmentId,
        contentType: "video/mp4",
        byteSize: 200,
        contentPath: `/api/attachments/${workProductAttachmentId}/content`,
        openPath: `/api/attachments/${workProductAttachmentId}/content`,
        downloadPath: `/api/attachments/${workProductAttachmentId}/content?download=1`,
        originalFilename: "primary-cut.mp4",
      },
      createdByRunId: runId,
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    });

    return { companyId, projectId, issueId, otherRunId };
  }

  it("projects agent-created documents, direct attachments, and work products while excluding noisy sources", async () => {
    const { companyId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Text file preview from an agent output.") });
    const result = await companyArtifactsService(db, storage).list(companyId, { limit: 20 });

    expect(result.nextCursor).toBeNull();
    expect(result.artifacts.map((artifact) => artifact.title)).toEqual([
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
      "notes.txt",
    ]);
    expect(result.artifacts.map((artifact) => artifact.source)).toEqual([
      "document",
      "attachment",
      "work_product",
      "attachment",
    ]);
    expect(result.artifacts.find((artifact) => artifact.title === "notes.txt")?.previewText)
      .toBe("Text file preview from an agent output.");
    expect(result.artifacts.some((artifact) => artifact.title === "primary-cut.mp4")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "Continuation Summary")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "operator-screenshot.png")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.title === "comment-screenshot.png")).toBe(false);
    expect(result.artifacts.some((artifact) => artifact.issue.identifier === "OTH-1")).toBe(false);
  });

  it("supports project, kind, search, and cursor filters", async () => {
    const { companyId, projectId } = await seedArtifacts();
    const storage = createStorageService({ "notes.txt": Buffer.from("Searchable notes preview") });

    const projectVideos = await companyArtifactsService(db, storage).list(companyId, {
      projectId,
      kind: "video",
      limit: 10,
    });
    expect(projectVideos.artifacts.map((artifact) => artifact.title)).toEqual(["direct-video.mp4", "Primary Cut"]);

    const search = await companyArtifactsService(db, storage).list(companyId, {
      q: "review document",
      limit: 10,
    });
    expect(search.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes"]);

    const firstPage = await companyArtifactsService(db, storage).list(companyId, { limit: 2 });
    expect(firstPage.artifacts.map((artifact) => artifact.title)).toEqual(["Review Notes", "direct-video.mp4"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.artifacts.map((artifact) => artifact.title)).toEqual(["Primary Cut", "notes.txt"]);

    const pageAfterPrimaryWorkProduct = await companyArtifactsService(db, storage).list(companyId, { limit: 3 });
    expect(pageAfterPrimaryWorkProduct.artifacts.map((artifact) => artifact.title)).toEqual([
      "Review Notes",
      "direct-video.mp4",
      "Primary Cut",
    ]);

    const afterPrimaryCursor = await companyArtifactsService(db, storage).list(companyId, {
      limit: 10,
      cursor: pageAfterPrimaryWorkProduct.nextCursor ?? undefined,
    });
    expect(afterPrimaryCursor.artifacts.map((artifact) => artifact.title)).toEqual(["notes.txt"]);
  });

  it("deduplicates work product attachments beyond the work product fetch window", async () => {
    const { companyId, projectId, issueId } = await seedArtifacts();
    const dedupedAttachmentId = "abababab-abab-4bab-8bab-abababababab";

    await db.insert(assets).values({
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      companyId,
      provider: "local_disk",
      objectKey: "late-render.mp4",
      contentType: "video/mp4",
      byteSize: 500,
      sha256: "sha256-late-render",
      originalFilename: "late-render.mp4",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
    });
    await db.insert(issueAttachments).values({
      id: dedupedAttachmentId,
      companyId,
      issueId,
      assetId: "acacacac-acac-4cac-8cac-acacacacacac",
      updatedAt: new Date("2026-01-20T00:00:00.000Z"),
    });

    const fillerWorkProducts = Array.from({ length: 21 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      companyId,
      projectId,
      issueId,
      type: "artifact" as const,
      provider: "paperclip",
      title: `Filler Video ${index + 1}`,
      status: "ready_for_review" as const,
      summary: "Filler artifact to push the attachment-backed work product past the fetch window",
      metadata: { contentType: "video/mp4" },
      createdByRunId: "99999999-9999-4999-8999-999999999999",
      updatedAt: new Date(`2026-01-10T00:${String(index).padStart(2, "0")}:00.000Z`),
    }));
    await db.insert(issueWorkProducts).values([
      ...fillerWorkProducts,
      {
        id: "adadadad-adad-4dad-8dad-adadadadadad",
        companyId,
        projectId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Late Render",
        status: "ready_for_review",
        summary: "Attachment-backed work product outside the limited fetch window",
        metadata: {
          attachmentId: dedupedAttachmentId,
          contentType: "video/mp4",
          byteSize: 500,
          contentPath: `/api/attachments/${dedupedAttachmentId}/content`,
          openPath: `/api/attachments/${dedupedAttachmentId}/content`,
          downloadPath: `/api/attachments/${dedupedAttachmentId}/content?download=1`,
          originalFilename: "late-render.mp4",
        },
        createdByRunId: "99999999-9999-4999-8999-999999999999",
        updatedAt: new Date("2026-01-01T12:00:00.000Z"),
      },
    ]);

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, {
      kind: "video",
      limit: 20,
    });

    expect(result.artifacts.some((artifact) => artifact.title === "late-render.mp4")).toBe(false);
  });

  it("does not project a foreign agent from a malformed work product run reference", async () => {
    const { companyId, issueId, otherRunId } = await seedArtifacts();

    await db.insert(issueWorkProducts).values({
      id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Forged Run Artifact",
      status: "ready_for_review",
      summary: "Historically malformed run attribution",
      metadata: { contentType: "text/plain" },
      createdByRunId: otherRunId,
      updatedAt: new Date("2026-01-10T00:00:00.000Z"),
    });

    const result = await companyArtifactsService(db, createStorageService()).list(companyId, { limit: 20 });
    const forged = result.artifacts.find((artifact) => artifact.title === "Forged Run Artifact");

    expect(forged).toBeTruthy();
    expect(forged?.createdByAgent).toBeNull();
    expect(result.artifacts.some((artifact) => artifact.createdByAgent?.name === "Other")).toBe(false);
  });
});

describe("company artifacts route authorization", () => {
  it("rejects agent access across company boundaries before reading artifacts", async () => {
    const app = express();
    app.use((_req, _res, next) => {
      (_req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-allowed",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any, createStorageService()));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/company-denied/artifacts");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });
});
