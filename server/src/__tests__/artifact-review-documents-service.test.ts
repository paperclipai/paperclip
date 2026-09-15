import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { artifactReviewDocumentKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { artifactReviewDocumentService } from "../services/artifact-review-documents.js";
import { documentService } from "../services/documents.js";
import { HttpError } from "../errors.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres artifact review document tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
        contentType: "text/markdown",
        contentLength: ranged.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describeEmbeddedPostgres("artifactReviewDocumentService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifact-review-docs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(options: {
    body?: Buffer;
    contentType?: string;
    originalFilename?: string | null;
    byteSize?: number;
  } = {}) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    const workProductId = randomUUID();
    const body = options.body ?? Buffer.from("# Report\n\nHello **markdown**.\n", "utf8");
    const contentType = options.contentType ?? "text/markdown";
    const originalFilename = options.originalFilename === undefined ? "report.md" : options.originalFilename;
    const objectKey = `issues/${issueId}/${assetId}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1534",
      title: "Bridge markdown work products",
      description: null,
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReportWriter",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey,
      contentType,
      byteSize: options.byteSize ?? body.length,
      sha256: `sha256-${assetId}`,
      originalFilename,
      createdByAgentId: agentId,
    });
    await db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
    });

    const contentPath = `/api/attachments/${attachmentId}/content`;
    const workProduct = {
      id: workProductId,
      companyId,
      issueId,
      type: "artifact" as const,
      provider: "paperclip",
      metadata: {
        attachmentId,
        contentType,
        byteSize: options.byteSize ?? body.length,
        contentPath,
        openPath: contentPath,
        downloadPath: `${contentPath}?download=1`,
        originalFilename,
      },
      title: "Verification report",
      createdByRunId: null,
      sourceTrust: null,
    };

    const files: Record<string, Buffer> = { [objectKey]: body };
    const storage = createStorageService(files);
    const svc = artifactReviewDocumentService(db, storage);
    return { companyId, issueId, agentId, assetId, attachmentId, workProduct, files, objectKey, svc };
  }

  it("materializes a review document with promoted attribution", async () => {
    const fixture = await seedFixture();
    const result = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });

    expect(result.created).toBe(true);
    expect(result.revisionChanged).toBe(true);
    expect(result.document.key).toBe(artifactReviewDocumentKey(fixture.workProduct.id));
    expect(result.document.title).toBe("Verification report");
    expect(result.document.latestRevisionNumber).toBe(1);
    expect(result.document.latestRevisionId).toBeTruthy();
    expect(result.document.body).toBe("# Report\n\nHello **markdown**.\n");
    expect(result.document.createdByAgentId).toBe(fixture.agentId);
    expect(result.document.createdByUserId).toBeNull();

    const listed = await documentService(db).getIssueDocumentByKey(
      fixture.issueId,
      artifactReviewDocumentKey(fixture.workProduct.id),
    );
    expect(listed?.id).toBe(result.document.id);
  });

  it("is idempotent for unchanged content", async () => {
    const fixture = await seedFixture();
    const first = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });
    const second = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });

    expect(second.created).toBe(false);
    expect(second.revisionChanged).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.latestRevisionNumber).toBe(1);

    const revisions = await db.select().from(documentRevisions);
    expect(revisions).toHaveLength(1);
  });

  it("converges concurrent ensures onto one document", async () => {
    const fixture = await seedFixture();
    const input = {
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    };
    const [first, second] = await Promise.all([
      fixture.svc.ensureForWorkProduct(input),
      fixture.svc.ensureForWorkProduct(input),
    ]);

    expect(first.document.id).toBe(second.document.id);
    const links = await db.select().from(issueDocuments);
    expect(links).toHaveLength(1);
    const revisions = await db.select().from(documentRevisions);
    expect(revisions).toHaveLength(1);
  });

  it("writes a new revision when the attachment content changes", async () => {
    const fixture = await seedFixture();
    const first = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });

    fixture.files[fixture.objectKey] = Buffer.from("# Report v2\n", "utf8");
    const second = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });

    expect(second.created).toBe(false);
    expect(second.revisionChanged).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.latestRevisionNumber).toBe(2);
    expect(second.document.body).toBe("# Report v2\n");
    expect(Array.isArray(second.remappedAnnotations)).toBe(true);
  });

  it("synchronizes title and run provenance when the attachment body is unchanged", async () => {
    const fixture = await seedFixture();
    const first = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });

    const renamed = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: { ...fixture.workProduct, title: "Renamed verification report" },
    });
    expect(renamed.created).toBe(false);
    expect(renamed.revisionChanged).toBe(true);
    expect(renamed.document.id).toBe(first.document.id);
    expect(renamed.document.title).toBe("Renamed verification report");
    expect(renamed.document.latestRevisionNumber).toBe(2);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "succeeded",
    });
    const reattributed = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: {
        ...fixture.workProduct,
        title: "Renamed verification report",
        createdByRunId: runId,
      },
    });
    expect(reattributed.revisionChanged).toBe(true);
    expect(reattributed.document.latestRevisionNumber).toBe(3);

    const latestRevision = await db
      .select()
      .from(documentRevisions)
      .then((rows) => rows.find((row) => row.id === reattributed.document.latestRevisionId));
    expect(latestRevision?.createdByRunId).toBe(runId);

    const unchanged = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: {
        ...fixture.workProduct,
        title: "Renamed verification report",
        createdByRunId: runId,
      },
    });
    expect(unchanged.revisionChanged).toBe(false);
    expect(unchanged.document.latestRevisionNumber).toBe(3);
  });

  it("rejects work products that are not attachment-backed Paperclip artifacts", async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: { ...fixture.workProduct, provider: "github" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: { ...fixture.workProduct, metadata: { attachmentId: "not-a-uuid" } },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects non-Markdown attachments with 415", async () => {
    const fixture = await seedFixture({ contentType: "application/pdf", originalFilename: "report.pdf" });
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: fixture.workProduct,
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects mismatched issues and cross-issue attachments", async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: randomUUID(), companyId: fixture.companyId },
        workProduct: fixture.workProduct,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: fixture.companyId,
      identifier: "PAP-1535",
      title: "Other issue",
      description: null,
      status: "todo",
      priority: "medium",
    });
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: otherIssueId, companyId: fixture.companyId },
        workProduct: { ...fixture.workProduct, issueId: otherIssueId },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects oversized attachments with 413", async () => {
    const fixture = await seedFixture({ byteSize: 512 * 1024 + 1 });
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: fixture.workProduct,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects invalid UTF-8 content with 422", async () => {
    const fixture = await seedFixture({ body: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x00]) });
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: fixture.workProduct,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("surfaces a conflict when the review document is locked and content changed", async () => {
    const fixture = await seedFixture();
    await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });
    await documentService(db).lockIssueDocument({
      issueId: fixture.issueId,
      key: artifactReviewDocumentKey(fixture.workProduct.id),
      lockedByUserId: "user-board",
    });

    // Unchanged content still resolves without a write.
    const unchanged = await fixture.svc.ensureForWorkProduct({
      issue: { id: fixture.issueId, companyId: fixture.companyId },
      workProduct: fixture.workProduct,
    });
    expect(unchanged.revisionChanged).toBe(false);

    fixture.files[fixture.objectKey] = Buffer.from("# Locked update\n", "utf8");
    await expect(
      fixture.svc.ensureForWorkProduct({
        issue: { id: fixture.issueId, companyId: fixture.companyId },
        workProduct: fixture.workProduct,
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof HttpError && error.status === 409);
  });
});
