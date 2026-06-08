import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  createAttachment: vi.fn(),
  getAttachmentById: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentReviewService: () => ({ remapOpenSuggestionsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

type TestStorageService = StorageService & {
  __calls: {
    putFile?: {
      companyId: string;
      namespace: string;
      originalFilename?: string;
      contentType: string;
      body: Buffer;
    };
  };
};

function createStorageService(body = Buffer.from("test")): TestStorageService {
  const calls: TestStorageService["__calls"] = {};
  return {
    provider: "local_disk",
    __calls: calls,
    putFile: async (input) => {
      calls.putFile = input;
      return {
      provider: "local_disk",
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
      };
    },
    getObject: vi.fn(async (_companyId, _objectKey, options) => {
      const range = options?.range;
      const streamBody = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(streamBody),
        contentLength: streamBody.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

async function createApp(storage: StorageService, options?: { companyIds?: string[]; source?: string }) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: options?.companyIds ?? ["company-1"],
      source: options?.source ?? "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, storage));
  app.use(errorHandler);
  return app;
}

function makeAttachment(contentType: string, originalFilename: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "attachment-1",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: `issues/issue-1/${originalFilename}`,
    contentType,
    byteSize: 4,
    sha256: "sha256-sample",
    originalFilename,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: now,
    updatedAt: now,
  };
}

function parseBinaryResponse(res: IncomingMessage, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
  res.on("error", callback);
}

describe("normalizeIssueAttachmentMaxBytes", () => {
  it("keeps the process-level attachment cap as the final cap", async () => {
    const previous = process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
    process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = "5";
    vi.resetModules();
    try {
      const { normalizeIssueAttachmentMaxBytes } = await import("../attachment-types.js");
      expect(normalizeIssueAttachmentMaxBytes(null)).toBe(5);
      expect(normalizeIssueAttachmentMaxBytes(10)).toBe(5);
      expect(normalizeIssueAttachmentMaxBytes(3)).toBe(3);
    } finally {
      if (previous === undefined) {
        delete process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES;
      } else {
        process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES = previous;
      }
      vi.resetModules();
    }
  });
});

describe("issue attachment routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 1024 * 1024 * 1024,
    });
    mockWorkProductService.createForIssue.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.update.mockReset();
  });

  it("accepts zip uploads for issue attachments", async () => {
    const storage = createStorageService();
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    });
    mockIssueService.createAttachment.mockResolvedValue(makeAttachment("application/zip", "bundle.zip"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("zip"), { filename: "bundle.zip", contentType: "application/zip" });

    expect([200, 201]).toContain(res.status);
    const putFileCall = storage.__calls.putFile;
    expect(putFileCall).toMatchObject({
      companyId: "company-1",
      namespace: "issues/11111111-1111-4111-8111-111111111111",
      originalFilename: "bundle.zip",
      contentType: "application/zip",
    });
    expect(Buffer.isBuffer(putFileCall?.body)).toBe(true);
    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "11111111-1111-4111-8111-111111111111",
        contentType: "application/zip",
        originalFilename: "bundle.zip",
      }),
    );
    expect(res.body.contentType).toBe("application/zip");
  });

  it("accepts default video uploads for issue attachments", async () => {
    const storage = createStorageService();
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    });
    mockIssueService.createAttachment.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("mp4"), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(201);
    expect(storage.__calls.putFile).toMatchObject({
      contentType: "video/mp4",
      originalFilename: "clip.mp4",
    });
    expect(res.body).toMatchObject({
      contentType: "video/mp4",
      contentPath: "/api/attachments/attachment-1/content",
      openPath: "/api/attachments/attachment-1/content",
      downloadPath: "/api/attachments/attachment-1/content?download=1",
    });
  });

  it("rejects unsupported upload content types before storing the file", async () => {
    const storage = createStorageService();
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("exe"), { filename: "payload.exe", contentType: "application/x-msdownload" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported attachment content type: application/x-msdownload");
    expect(storage.__calls.putFile).toBeUndefined();
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
  });

  it("enforces the process-level issue attachment limit even when the company limit allows more", async () => {
    const storage = createStorageService();
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    });
    mockIssueService.createAttachment.mockResolvedValue(makeAttachment("application/octet-stream", "large.bin"));

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: "large.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment exceeds 10485760 bytes");
    expect(storage.__calls.putFile).toBeUndefined();
  });

  it("enforces the configured per-company issue attachment limit", async () => {
    const storage = createStorageService();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 4,
    });
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post("/api/companies/company-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .attach("file", Buffer.from("large"), { filename: "large.txt", contentType: "text/plain" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment exceeds 4 bytes");
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
  });

  it("serves html attachments as downloads with nosniff", async () => {
    const storage = createStorageService();
    mockIssueService.getAttachmentById.mockResolvedValue(makeAttachment("text/html", "report.html"));

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .buffer(true)
      .parse(parseBinaryResponse);

    expect(res.status).toBe(200);
    expect([
      undefined,
      'attachment; filename="report.html"',
    ]).toContain(res.headers["content-disposition"]);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps image attachments inline for previews", async () => {
    const storage = createStorageService();
    mockIssueService.getAttachmentById.mockResolvedValue(makeAttachment("image/png", "preview.png"));

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content");

    expect(res.status).toBe(200);
    expect([
      undefined,
      'inline; filename="preview.png"',
    ]).toContain(res.headers["content-disposition"]);
  });

  it("serves video attachments inline with byte-range support", async () => {
    const storage = createStorageService(Buffer.from("abcdef"));
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      byteSize: 6,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .set("Range", "bytes=1-3");

    expect(res.status).toBe(206);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBe("bytes 1-3/6");
    expect(res.headers["content-length"]).toBe("3");
    expect(res.headers["content-disposition"]).toBe('inline; filename="clip.mp4"');
    expect(Buffer.from(res.body).toString("utf8")).toBe("bcd");
    expect(storage.getObject).toHaveBeenCalledWith(
      "company-1",
      "issues/issue-1/clip.mp4",
      { range: { start: 1, end: 3 } },
    );
  });

  it("serves mp4 attachments inline when stored with a generic binary content type", async () => {
    const storage = createStorageService(Buffer.from("abcdef"));
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("application/octet-stream", "clip.mp4"),
      byteSize: 6,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .set("Range", "bytes=1-3");

    expect(res.status).toBe(206);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["content-disposition"]).toBe('inline; filename="clip.mp4"');
    expect(res.headers["content-range"]).toBe("bytes 1-3/6");
    expect(Buffer.from(res.body).toString("utf8")).toBe("bcd");
  });

  it("forces video downloads when the download path is requested", async () => {
    const storage = createStorageService();
    mockIssueService.getAttachmentById.mockResolvedValue(makeAttachment("video/webm", "clip.webm"));

    const app = await createApp(storage);
    const res = await request(app).get("/api/attachments/attachment-1/content?download=1");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="clip.webm"');
  });

  it("rejects invalid byte ranges without streaming the object", async () => {
    const storage = createStorageService();
    mockIssueService.getAttachmentById.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage);
    const res = await request(app)
      .get("/api/attachments/attachment-1/content")
      .set("Range", "bytes=99-100");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */4");
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("rejects cross-company attachment content reads", async () => {
    const storage = createStorageService();
    mockIssueService.getAttachmentById.mockResolvedValue(makeAttachment("video/mp4", "clip.mp4"));

    const app = await createApp(storage, { companyIds: ["company-2"], source: "session" });
    const res = await request(app).get("/api/attachments/attachment-1/content");

    expect(res.status).toBe(403);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("canonicalizes paperclip artifact metadata before creating a work product", async () => {
    const storage = createStorageService();
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
      projectId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      id: "22222222-2222-4222-8222-222222222222",
      byteSize: 6,
      issueId: issue.id,
    });
    mockWorkProductService.createForIssue.mockResolvedValue({
      id: "work-product-1",
      issueId: issue.id,
      companyId: issue.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "artifact",
        provider: "paperclip",
        title: "Clip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/mp4",
          byteSize: 6,
          contentPath: "https://evil.example/clip.mp4",
          openPath: "javascript:alert(1)",
          downloadPath: "javascript:alert(2)",
          originalFilename: "clip.mp4",
        },
      });

    expect(res.status).toBe(201);
    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      issue.id,
      issue.companyId,
      expect.objectContaining({
        type: "artifact",
        provider: "paperclip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/mp4",
          byteSize: 6,
          contentPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          openPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          downloadPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content?download=1",
          originalFilename: "clip.mp4",
        },
      }),
    );
  });

  it("rejects paperclip artifact metadata that references another issue's attachment", async () => {
    const storage = createStorageService();
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
      projectId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/mp4", "clip.mp4"),
      id: "22222222-2222-4222-8222-222222222222",
      issueId: "different-issue",
    });

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/issues/${issue.id}/work-products`)
      .send({
        type: "artifact",
        provider: "paperclip",
        title: "Clip",
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment artifact must reference an attachment on the same issue");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("canonicalizes paperclip artifact metadata on work product updates", async () => {
    const storage = createStorageService();
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
      projectId: null,
    };
    mockWorkProductService.getById.mockResolvedValue({
      id: "work-product-1",
      issueId: issue.id,
      companyId: issue.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("video/webm", "clip.webm"),
      id: "22222222-2222-4222-8222-222222222222",
      issueId: issue.id,
      byteSize: 8,
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "work-product-1",
      issueId: issue.id,
      companyId: issue.companyId,
      type: "artifact",
      provider: "paperclip",
      title: "Clip",
      metadata: null,
    });

    const app = await createApp(storage);
    const res = await request(app)
      .patch("/api/work-products/work-product-1")
      .send({
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          openPath: "javascript:alert(1)",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkProductService.update).toHaveBeenCalledWith(
      "work-product-1",
      expect.objectContaining({
        metadata: {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          contentType: "video/webm",
          byteSize: 8,
          contentPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          openPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
          downloadPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content?download=1",
          originalFilename: "clip.webm",
        },
      }),
    );
  });
});
