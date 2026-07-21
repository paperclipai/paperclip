import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";
import type { ImageReferenceInput } from "../services/openai-image-generation.js";

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
const mockGenerateCodexIssueImage = vi.hoisted(() => vi.fn());
const mockResolveIssueImageReferenceGuardrail = vi.hoisted(() => vi.fn());
const mockHasReferenceBackedImageGenerationEvidence = vi.hoisted(() => vi.fn());

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

  vi.doMock("../services/image-reference-guardrails.js", () => ({
    resolveIssueImageReferenceGuardrail: mockResolveIssueImageReferenceGuardrail,
    hasReferenceBackedImageGenerationEvidence: mockHasReferenceBackedImageGenerationEvidence,
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

async function createApp(storage: StorageService, db: any = {}) {
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
  app.use("/api", issueRoutes(db, storage));
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

function createAssetQueryDb(...assets: Array<Record<string, unknown>>) {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: async <T>(resolve: (rows: Array<Record<string, unknown>>) => T) => {
            const asset = assets[index++];
            return resolve(asset ? [asset] : []);
          },
        }),
      }),
    }),
  };
}

async function createPng(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 90, b: 180 },
    },
  }).png().toBuffer();
}

function hasPngColorSpaceEvidence(bytes: Buffer) {
  return ["sRGB", "iCCP", "gAMA", "cHRM"].some((chunkName) => bytes.includes(Buffer.from(chunkName, "ascii")));
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
    vi.doUnmock("../services/codex-image-generation.js");
    vi.doUnmock("../services/openai-image-generation.js");
    vi.doUnmock("../services/image-reference-guardrails.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockResolveIssueImageReferenceGuardrail.mockResolvedValue({
      required: false,
      issueScopeIds: ["11111111-1111-4111-8111-111111111111"],
      boardText: "",
      candidateAttachmentIds: [],
      candidateAssetIds: [],
    });
    mockHasReferenceBackedImageGenerationEvidence.mockResolvedValue(false);
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
      .attach("file", Buffer.alloc(30 * 1024 * 1024 + 1), {
        filename: "large.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Attachment exceeds 31457280 bytes");
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

  it("accepts 16 image reference ids at validation and rejects a seventeenth", async () => {
    const storage = createStorageService();
    const referenceIds = Array.from(
      { length: 17 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    mockIssueService.getById.mockResolvedValue(null);
    const app = await createApp(storage);

    const accepted = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/image-generations")
      .send({
        prompt: "Use all references according to their named roles.",
        referenceImageAttachmentIds: referenceIds.slice(0, 16),
      });
    expect(accepted.status).toBe(404);
    expect(accepted.body.error).toBe("Issue not found");

    const rejected = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/image-generations")
      .send({
        prompt: "This request exceeds the provider-supported input count.",
        referenceImageAttachmentIds: referenceIds,
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("Validation error");
    expect(mockIssueService.getById).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe non-exact image generation sizes before provider work", async () => {
    const storage = createStorageService();
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      identifier: "PAP-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/issues/${issue.id}/image-generations`)
      .send({
        prompt: "Generate with an invalid size.",
        size: "auto",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("exact WxH pixel size");
    expect(mockGenerateCodexIssueImage).not.toHaveBeenCalled();
    expect(storage.__calls.putFiles).toHaveLength(0);
  });

  it("binds reference image attachment bytes to the OpenAI image edit request", async () => {
    const previousImageKey = process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY;
    const previousImageProvider = process.env.PAPERCLIP_IMAGE_PROVIDER;
    process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY = "sk-test-image-key";
    process.env.PAPERCLIP_IMAGE_PROVIDER = "openai";
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
    const generatedPng = await createPng(1080, 1350);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: generatedPng.toString("base64") }],
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
      const outputMetadata = await sharp(storage.__calls.putFiles[0]?.body).metadata();
      expect(outputMetadata.width).toBe(1080);
      expect(outputMetadata.height).toBe(1350);
      expect(hasPngColorSpaceEvidence(storage.__calls.putFiles[0]?.body)).toBe(true);

      const audit = JSON.parse(storage.__calls.putFiles[1]?.body.toString() ?? "{}") as {
        model?: string;
        generationMode?: string;
        actualImageInputsBound?: string[];
        outputAttachmentId?: string;
        outputDimensions?: { width?: number; height?: number };
        outputPngColorSpaceEvidence?: Record<string, boolean>;
      };
      expect(audit.model).toBe("gpt-image-2");
      expect(audit.generationMode).toBe("reference_backed");
      expect(audit.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(audit.outputAttachmentId).toBe(outputAttachment.id);
      expect(audit.outputDimensions).toEqual({ width: 1080, height: 1350 });
      expect(Object.values(audit.outputPngColorSpaceEvidence ?? {}).some(Boolean)).toBe(true);
      expect(res.body.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(res.body.outputAttachment.contentPath).toBe(`/api/attachments/${outputAttachment.id}/content`);
      expect(res.body.auditAttachment.contentPath).toBe(`/api/attachments/${auditAttachment.id}/content`);
    } finally {
      if (previousImageKey === undefined) {
        delete process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY;
      } else {
        process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY = previousImageKey;
      }
      if (previousImageProvider === undefined) {
        delete process.env.PAPERCLIP_IMAGE_PROVIDER;
      } else {
        process.env.PAPERCLIP_IMAGE_PROVIDER = previousImageProvider;
      }
    }
  });

  it("uses Codex-native image generation by default with bound reference attachments", async () => {
    const previousImageProvider = process.env.PAPERCLIP_IMAGE_PROVIDER;
    delete process.env.PAPERCLIP_IMAGE_PROVIDER;
    mockGenerateCodexIssueImage.mockReset();
    vi.doMock("../services/codex-image-generation.js", () => ({
      generateCodexIssueImage: mockGenerateCodexIssueImage,
    }));

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
    mockGenerateCodexIssueImage.mockResolvedValue({
      provider: "codex_native",
      model: "gpt-image-2",
      endpoint: "codex_exec_image_gen",
      generationMode: "reference_backed",
      actualImageInputsBound: [referenceAttachmentId],
      outputBytes: await createPng(1080, 1350),
      outputContentType: "image/png",
      providerRequestId: "019f286b-9bae-7961-bb48-e5c658f53427",
      codexThreadId: "019f286b-9bae-7961-bb48-e5c658f53427",
      codexOutputPath: "/paperclip/.codex/generated_images/019f286b-9bae-7961-bb48-e5c658f53427/ig_test.png",
    });
    const fetchMock = vi.fn();
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
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGenerateCodexIssueImage).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "Generate a cafe founder carousel image.",
        size: "1080x1350",
        quality: "high",
        companyId: "company-1",
        references: [expect.objectContaining({
          attachmentId: referenceAttachmentId,
          filename: "foto_event.png",
          contentType: "image/png",
          bytes: Buffer.from("PNGDATA"),
        })],
      }));

      const audit = JSON.parse(storage.__calls.putFiles[1]?.body.toString() ?? "{}") as {
        provider?: string;
        generationMode?: string;
        actualImageInputsBound?: string[];
        codexThreadId?: string;
        outputDimensions?: { width?: number; height?: number };
      };
      expect(audit.provider).toBe("codex_native");
      expect(audit.generationMode).toBe("reference_backed");
      expect(audit.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(audit.codexThreadId).toBe("019f286b-9bae-7961-bb48-e5c658f53427");
      expect(audit.outputDimensions).toEqual({ width: 1080, height: 1350 });
      expect(res.body.provider).toBe("codex_native");
    } finally {
      if (previousImageProvider === undefined) {
        delete process.env.PAPERCLIP_IMAGE_PROVIDER;
      } else {
        process.env.PAPERCLIP_IMAGE_PROVIDER = previousImageProvider;
      }
    }
  });

  it("normalizes audited reference-backed image output to the requested size with explicit sRGB evidence", async () => {
    const previousImageProvider = process.env.PAPERCLIP_IMAGE_PROVIDER;
    delete process.env.PAPERCLIP_IMAGE_PROVIDER;
    mockGenerateCodexIssueImage.mockReset();
    vi.doMock("../services/codex-image-generation.js", () => ({
      generateCodexIssueImage: mockGenerateCodexIssueImage,
    }));

    const issueId = "11111111-1111-4111-8111-111111111111";
    const referenceAttachmentId = "2d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const providerPng = await createPng(1122, 1402);
    expect(hasPngColorSpaceEvidence(providerPng)).toBe(false);

    const storage = createStorageService();
    storage.getObject = vi.fn(async () => ({
      stream: Readable.from(Buffer.from("PNGDATA")),
      contentType: "image/png",
      contentLength: 7,
    }));
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId: "company-1",
      identifier: "SIX-4034",
    });
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("image/png", "source-still.png"),
      id: referenceAttachmentId,
      issueId,
    });
    mockIssueService.createAttachment
      .mockResolvedValueOnce({
        ...makeAttachment("image/png", "final.png"),
        id: "33333333-3333-4333-8333-333333333333",
        issueId,
      })
      .mockResolvedValueOnce({
        ...makeAttachment("application/json", "paperclip-image-audit.json"),
        id: "44444444-4444-4444-8444-444444444444",
        issueId,
      });
    mockGenerateCodexIssueImage.mockResolvedValue({
      provider: "codex_native",
      model: "gpt-image-2",
      endpoint: "codex_exec_image_gen",
      generationMode: "reference_backed",
      actualImageInputsBound: [referenceAttachmentId],
      outputBytes: providerPng,
      outputContentType: "image/png",
      providerRequestId: "thread-4036",
      codexThreadId: "thread-4036",
      codexOutputPath: null,
    });

    try {
      const app = await createApp(storage);
      const res = await request(app)
        .post(`/api/issues/${issueId}/image-generations`)
        .send({
          prompt: "Regenerate the ad using the supplied still as a real image reference.",
          referenceImageAttachmentIds: [referenceAttachmentId],
          size: "1080x1350",
          quality: "high",
          outputFilename: "final.png",
        });

      expect(res.status).toBe(201);
      const outputBytes = storage.__calls.putFiles[0]?.body;
      const outputMetadata = await sharp(outputBytes).metadata();
      expect(outputMetadata.width).toBe(1080);
      expect(outputMetadata.height).toBe(1350);
      expect(hasPngColorSpaceEvidence(outputBytes)).toBe(true);

      const audit = JSON.parse(storage.__calls.putFiles[1]?.body.toString() ?? "{}") as {
        generationMode?: string;
        promptOnly?: boolean;
        actualImageInputsBound?: string[];
        outputAttachmentId?: string;
        providerOutputDimensions?: { width?: number; height?: number };
        outputDimensions?: { width?: number; height?: number };
        outputPngColorSpaceEvidence?: Record<string, boolean>;
        referenceImageInputs?: Array<{ sourceKind?: string; sourceId?: string; byteSize?: number }>;
      };
      expect(audit.outputAttachmentId).toBe("33333333-3333-4333-8333-333333333333");
      expect(audit.providerOutputDimensions).toEqual({ width: 1122, height: 1402 });
      expect(audit.outputDimensions).toEqual({ width: 1080, height: 1350 });
      expect(Object.values(audit.outputPngColorSpaceEvidence ?? {}).some(Boolean)).toBe(true);
      expect(audit.generationMode).toBe("reference_backed");
      expect(audit.promptOnly).toBe(false);
      expect(audit.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(audit.referenceImageInputs).toEqual([
        expect.objectContaining({
          sourceKind: "attachment",
          sourceId: referenceAttachmentId,
          byteSize: 7,
        }),
      ]);
      expect(res.body.outputAttachmentId).toBe(audit.outputAttachmentId);
      expect(res.body.outputDimensions).toEqual({ width: 1080, height: 1350 });
      expect(res.body.actualImageInputsBound).toEqual([referenceAttachmentId]);
    } finally {
      if (previousImageProvider === undefined) delete process.env.PAPERCLIP_IMAGE_PROVIDER;
      else process.env.PAPERCLIP_IMAGE_PROVIDER = previousImageProvider;
    }
  });

  it("auto-binds board-required image attachments and records the guardrail audit", async () => {
    const previousImageProvider = process.env.PAPERCLIP_IMAGE_PROVIDER;
    delete process.env.PAPERCLIP_IMAGE_PROVIDER;
    mockGenerateCodexIssueImage.mockReset();
    vi.doMock("../services/codex-image-generation.js", () => ({
      generateCodexIssueImage: mockGenerateCodexIssueImage,
    }));

    const issueId = "11111111-1111-4111-8111-111111111111";
    const referenceAttachmentId = "2d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const storage = createStorageService();
    storage.getObject = vi.fn(async () => ({
      stream: Readable.from(Buffer.from("PNGDATA")),
      contentType: "image/png",
      contentLength: 7,
    }));
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId: "company-1",
      identifier: "SIX-3832",
    });
    mockIssueService.getAttachmentById.mockResolvedValue({
      ...makeAttachment("image/png", "portrait-reference.png"),
      id: referenceAttachmentId,
      issueId,
    });
    mockIssueService.createAttachment
      .mockResolvedValueOnce({
        ...makeAttachment("image/png", "corrected.png"),
        id: "33333333-3333-4333-8333-333333333333",
        issueId,
      })
      .mockResolvedValueOnce({
        ...makeAttachment("application/json", "paperclip-image-audit.json"),
        id: "44444444-4444-4444-8444-444444444444",
        issueId,
      });
    mockResolveIssueImageReferenceGuardrail.mockResolvedValue({
      required: true,
      issueScopeIds: [issueId],
      boardText: "Use my attached portrait as an actual image reference, not prompt-only text.",
      candidateAttachmentIds: [referenceAttachmentId],
      candidateAssetIds: [],
    });
    mockGenerateCodexIssueImage.mockImplementation(async (input) => ({
      provider: "codex_native",
      model: "gpt-image-2",
      endpoint: "codex_exec_image_gen",
      generationMode: input.references.length > 0 ? "reference_backed" : "prompt_only",
      actualImageInputsBound: input.references.map((reference: ImageReferenceInput) => reference.sourceId),
      outputBytes: await createPng(1024, 1024),
      outputContentType: "image/png",
      providerRequestId: "thread-1",
      codexThreadId: "thread-1",
      codexOutputPath: null,
    }));

    try {
      const app = await createApp(storage);
      const res = await request(app)
        .post(`/api/issues/${issueId}/image-generations`)
        .send({
          prompt: "Correct the portrait while preserving the composition.",
          size: "1024x1024",
          quality: "high",
          referenceImageAttachmentIds: [],
          referenceImageAssetIds: [],
        });

      expect(res.status).toBe(201);
      expect(res.body.boardReferenceIntentDetected).toBe(true);
      expect(res.body.generationMode).toBe("reference_backed");
      expect(res.body.actualImageInputsBound).toEqual([referenceAttachmentId]);
      expect(res.body.autoBoundReferenceImageAttachmentIds).toEqual([referenceAttachmentId]);
      expect(mockGenerateCodexIssueImage).toHaveBeenCalledWith(expect.objectContaining({
        references: [expect.objectContaining({
          sourceKind: "attachment",
          sourceId: referenceAttachmentId,
        })],
      }));

      const audit = JSON.parse(storage.__calls.putFiles[1]?.body.toString() ?? "{}") as {
        referenceGuardrailApplied?: boolean;
        referenceImageInputs?: Array<{ sourceKind?: string; sourceId?: string }>;
      };
      expect(audit.referenceGuardrailApplied).toBe(true);
      expect(audit.referenceImageInputs).toEqual([
        expect.objectContaining({ sourceKind: "attachment", sourceId: referenceAttachmentId }),
      ]);
    } finally {
      if (previousImageProvider === undefined) delete process.env.PAPERCLIP_IMAGE_PROVIDER;
      else process.env.PAPERCLIP_IMAGE_PROVIDER = previousImageProvider;
    }
  });

  it("treats explicit attachment and asset selection as authoritative, dedupes inputs, and suppresses board-linked candidates", async () => {
    const previousImageProvider = process.env.PAPERCLIP_IMAGE_PROVIDER;
    delete process.env.PAPERCLIP_IMAGE_PROVIDER;
    mockGenerateCodexIssueImage.mockReset();
    vi.doMock("../services/codex-image-generation.js", () => ({
      generateCodexIssueImage: mockGenerateCodexIssueImage,
    }));

    const issueId = "11111111-1111-4111-8111-111111111111";
    const selectedAttachmentId = "2d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const selectedAssetId = "5d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const autoAttachmentId = "3d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const autoAssetId = "4d8a654e-2ece-43cf-9000-ab0fe254e1a6";
    const storage = createStorageService();
    storage.getObject = vi.fn(async () => ({
      stream: Readable.from(Buffer.from("PNGDATA")),
      contentType: "image/png",
      contentLength: 7,
    }));
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId: "company-1",
      identifier: "SIX-4514",
    });
    mockIssueService.getAttachmentById.mockImplementation(async (id: string) => {
      if (id !== selectedAttachmentId) throw new Error(`unexpected reference lookup: ${id}`);
      return {
        ...makeAttachment("image/png", "selected-reference.png"),
        id: selectedAttachmentId,
        issueId,
        sha256: "selected-reference-sha",
      };
    });
    mockIssueService.createAttachment
      .mockResolvedValueOnce({
        ...makeAttachment("image/png", "corrected.png"),
        id: "33333333-3333-4333-8333-333333333333",
        issueId,
      })
      .mockResolvedValueOnce({
        ...makeAttachment("application/json", "paperclip-image-audit.json"),
        id: "44444444-4444-4444-8444-444444444444",
        issueId,
      });
    mockResolveIssueImageReferenceGuardrail.mockResolvedValue({
      required: true,
      issueScopeIds: [issueId],
      boardText: "Use a supplied image as an actual reference.",
      candidateAttachmentIds: [autoAttachmentId],
      candidateAssetIds: [autoAssetId],
    });
    mockGenerateCodexIssueImage.mockImplementation(async (input) => ({
      provider: "codex_native",
      model: "gpt-image-2",
      endpoint: "codex_exec_image_gen",
      generationMode: input.references.length > 0 ? "reference_backed" : "prompt_only",
      actualImageInputsBound: input.references.map((reference: ImageReferenceInput) => reference.sourceId),
      outputBytes: await createPng(1024, 1024),
      outputContentType: "image/png",
      providerRequestId: "thread-2",
      codexThreadId: "thread-2",
      codexOutputPath: null,
    }));

    try {
      const app = await createApp(storage, createAssetQueryDb({
        id: selectedAssetId,
        companyId: "company-1",
        objectKey: "assets/selected-reference.png",
        contentType: "image/png",
        byteSize: 7,
        sha256: "selected-asset-sha",
        originalFilename: "selected-asset-reference.png",
      }));
      const res = await request(app)
        .post(`/api/issues/${issueId}/image-generations`)
        .send({
          prompt: "Use only the specifically selected image reference.",
          size: "1024x1024",
          quality: "high",
          referenceImageAttachmentIds: [selectedAttachmentId, selectedAttachmentId],
          referenceImageAssetIds: [selectedAssetId],
        });

      expect(res.status).toBe(201);
      expect(res.body.generationMode).toBe("reference_backed");
      expect(res.body.actualImageInputsBound).toEqual([selectedAttachmentId, selectedAssetId]);
      expect(res.body.autoBoundReferenceImageAttachmentIds).toEqual([]);
      expect(res.body.autoBoundReferenceImageAssetIds).toEqual([]);
      expect(mockGenerateCodexIssueImage).toHaveBeenCalledWith(expect.objectContaining({
        references: [
          expect.objectContaining({ sourceId: selectedAttachmentId }),
          expect.objectContaining({ sourceId: selectedAssetId }),
        ],
      }));
    } finally {
      if (previousImageProvider === undefined) delete process.env.PAPERCLIP_IMAGE_PROVIDER;
      else process.env.PAPERCLIP_IMAGE_PROVIDER = previousImageProvider;
    }
  });

  it("rejects more than sixteen combined explicit references with 422", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const attachmentIds = Array.from(
      { length: 16 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const assetId = "99999999-9999-4999-8999-999999999999";
    const storage = createStorageService();
    storage.getObject = vi.fn(async () => ({
      stream: Readable.from(Buffer.from("PNGDATA")),
      contentType: "image/png",
      contentLength: 7,
    }));
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId: "company-1",
      identifier: "SIX-4514",
    });
    mockIssueService.getAttachmentById.mockImplementation(async (id: string) => ({
      ...makeAttachment("image/png", `${id}.png`),
      id,
      issueId,
    }));
    const app = await createApp(storage, createAssetQueryDb({
      id: assetId,
      companyId: "company-1",
      objectKey: "assets/seventeenth-reference.png",
      contentType: "image/png",
      byteSize: 7,
      sha256: "seventeenth-reference-sha",
      originalFilename: "seventeenth-reference.png",
    }));

    const res = await request(app)
      .post(`/api/issues/${issueId}/image-generations`)
      .send({
        prompt: "Use each selected image reference according to its role.",
        referenceImageAttachmentIds: attachmentIds,
        referenceImageAssetIds: [assetId],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("At most 16 unique image reference inputs");
  });
});
