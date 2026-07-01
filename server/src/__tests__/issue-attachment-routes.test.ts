import { Readable } from "node:stream";
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
    budgetService: () => ({
      upsertPolicy: vi.fn(async () => null),
    }),
    companyService: () => mockCompanyService,
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
    resolveAllCredentialEnv: vi.fn(async () => ({ env: {}, credentialIds: [], chosen: [] })),
    workProductService: () => ({}),
    issueVisibilityService: () => ({
      canSeeIssue: vi.fn(async () => true),
      filterVisibleIssues: vi.fn(async (_principal, issues) => issues),
      ensureCollaborator: vi.fn(async () => undefined),
      resolveMentionsToCollaborators: vi.fn(async () => undefined),
      listCollaborators: vi.fn(async () => []),
      removeCollaborator: vi.fn(async () => undefined),
    }),
    webPushService: () => ({
      sendToUser: vi.fn(async () => undefined),
      sendToUsers: vi.fn(async () => undefined),
      notifyUsers: vi.fn(async () => undefined),
    }),
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
    putFiles: Array<{
      companyId: string;
      namespace: string;
      originalFilename?: string;
      contentType: string;
      body: Buffer;
    }>;
  };
};

function createStorageService(): TestStorageService {
  const calls: TestStorageService["__calls"] = { putFiles: [] };
  return {
    provider: "local_disk",
    __calls: calls,
    putFile: async (input) => {
      calls.putFile = input;
      calls.putFiles.push(input);
      return {
      provider: "local_disk",
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
      };
    },
    getObject: vi.fn(async () => ({
      stream: Readable.from(Buffer.from("test")),
      contentLength: 4,
    })),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

async function createApp(storage: StorageService) {
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
      companyIds: ["company-1"],
      source: "local_implicit",
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
    const res = await request(app).get("/api/attachments/attachment-1/content");

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

  it("binds reference image attachment bytes to the OpenAI image edit request", async () => {
    const previousImageKey = process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY;
    process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY = "sk-test-image-key";
    const referenceAttachmentId = "2d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const storage = createStorageService();
    storage.getObject = vi.fn(async () => ({
      stream: Readable.from(Buffer.from("PNGDATA")),
      contentType: "image/png",
      contentLength: 7,
    }));
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    };
    const referenceAttachment = {
      ...makeAttachment("image/png", "foto_event.png"),
      id: referenceAttachmentId,
      issueId: issue.id,
    };
    const outputAttachment = {
      ...makeAttachment("image/png", "carousel.png"),
      id: "33333333-3333-4333-8333-333333333333",
      issueId: issue.id,
    };
    const auditAttachment = {
      ...makeAttachment("application/json", "paperclip-image-audit.json"),
      id: "44444444-4444-4444-8444-444444444444",
      issueId: issue.id,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getAttachmentById.mockResolvedValue(referenceAttachment);
    mockIssueService.createAttachment
      .mockResolvedValueOnce(outputAttachment)
      .mockResolvedValueOnce(auditAttachment);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("generated-png").toString("base64") }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "req_image_123",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = await createApp(storage);
      const res = await request(app)
        .post(`/api/issues/${issue.id}/image-generations`)
        .send({
          prompt: "Generate a cafe founder carousel image.",
          referenceImageAttachmentIds: [referenceAttachmentId],
          size: "1080x1350",
          quality: "high",
          model: "gpt-image-2",
          outputFilename: "carousel.png",
        });

      expect(res.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe("https://api.openai.com/v1/images/edits");
      expect(init.method).toBe("POST");
      const form = init.body as FormData;
      expect(form.get("model")).toBe("gpt-image-2");
      expect(form.get("prompt")).toBe("Generate a cafe founder carousel image.");
      expect(form.get("size")).toBe("1080x1350");
      expect(form.get("quality")).toBe("high");
      const imageParts = form.getAll("image[]");
      expect(imageParts).toHaveLength(1);
      expect(await (imageParts[0] as Blob).text()).toBe("PNGDATA");

      expect(storage.__calls.putFiles).toHaveLength(2);
      expect(storage.__calls.putFiles[0]).toMatchObject({
        contentType: "image/png",
        originalFilename: "carousel.png",
      });
      expect(storage.__calls.putFiles[0]?.body.toString()).toBe("generated-png");

      const audit = JSON.parse(storage.__calls.putFiles[1]?.body.toString() ?? "{}") as {
        model?: string;
        generationMode?: string;
        actualImageInputsBound?: string[];
        outputAttachmentId?: string;
      };
      expect(audit.model).toBe("gpt-image-2");
      expect(audit.generationMode).toBe("reference_backed");
      expect(audit.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(audit.outputAttachmentId).toBe(outputAttachment.id);
      expect(res.body.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(res.body.outputAttachment.contentPath).toBe(`/api/attachments/${outputAttachment.id}/content`);
      expect(res.body.auditAttachment.contentPath).toBe(`/api/attachments/${auditAttachment.id}/content`);
    } finally {
      if (previousImageKey === undefined) {
        delete process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY;
      } else {
        process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY = previousImageKey;
      }
    }
  });
});
