import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const WORK_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
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
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({
    allowed: true,
    explanation: "Allowed by test mock",
  })),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnsureForWorkProduct = vi.hoisted(() => vi.fn());
const mockSyncDocumentSafely = vi.hoisted(() => vi.fn(async () => undefined));

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

  vi.doMock("../services/artifact-review-documents.js", () => ({
    artifactReviewDocumentService: () => ({
      ensureForWorkProduct: mockEnsureForWorkProduct,
    }),
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => ({
      syncDocumentSafely: mockSyncDocumentSafely,
    }),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(),
    }),
    companySkillService: () => ({}),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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

function createStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

async function createApp(options?: { companyIds?: string[] }) {
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
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, createStorageService()));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    identifier: "PAP-1",
    projectId: null,
    status: "in_progress",
    assigneeAgentId: null,
  };
}

function makeWorkProduct(overrides: Record<string, unknown> = {}) {
  const attachmentId = "55555555-5555-4555-8555-555555555555";
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id: WORK_PRODUCT_ID,
    companyId: "company-1",
    issueId: ISSUE_ID,
    type: "artifact",
    provider: "paperclip",
    title: "Verification report",
    metadata: {
      attachmentId,
      contentType: "text/markdown",
      byteSize: 128,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: "verification-report.md",
    },
    createdByRunId: null,
    sourceTrust: null,
    ...overrides,
  };
}

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: "company-1",
    issueId: ISSUE_ID,
    key: `artifact-review-${WORK_PRODUCT_ID}`,
    title: "Verification report",
    format: "markdown",
    body: "# Report",
    latestRevisionId: "44444444-4444-4444-8444-444444444444",
    latestRevisionNumber: 1,
    ...overrides,
  };
}

describe("work product review-document route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    registerRouteMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockWorkProductService.getById.mockResolvedValue(makeWorkProduct());
  });

  it("returns 404 when the work product belongs to another issue", async () => {
    mockWorkProductService.getById.mockResolvedValue(
      makeWorkProduct({ issueId: "55555555-5555-4555-8555-555555555555" }),
    );

    const app = await createApp();
    const res = await request(app).post(
      `/api/issues/${ISSUE_ID}/work-products/${WORK_PRODUCT_ID}/review-document`,
    );

    expect(res.status).toBe(404);
    expect(mockEnsureForWorkProduct).not.toHaveBeenCalled();
  });

  it("returns 404 when the work product does not exist", async () => {
    mockWorkProductService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).post(
      `/api/issues/${ISSUE_ID}/work-products/${WORK_PRODUCT_ID}/review-document`,
    );

    expect(res.status).toBe(404);
    expect(mockEnsureForWorkProduct).not.toHaveBeenCalled();
  });

  it("materializes the review document and logs document creation", async () => {
    mockEnsureForWorkProduct.mockResolvedValue({
      document: makeDocument(),
      created: true,
      revisionChanged: true,
      remappedAnnotations: [],
    });

    const app = await createApp();
    const res = await request(app).post(
      `/api/issues/${ISSUE_ID}/work-products/${WORK_PRODUCT_ID}/review-document`,
    );

    expect(res.status).toBe(201);
    expect(res.body.key).toBe(`artifact-review-${WORK_PRODUCT_ID}`);
    expect(mockEnsureForWorkProduct).toHaveBeenCalledWith({
      issue: { id: ISSUE_ID, companyId: "company-1" },
      workProduct: expect.objectContaining({ id: WORK_PRODUCT_ID }),
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.document_created",
        details: expect.objectContaining({
          workProductId: WORK_PRODUCT_ID,
          artifactReviewDocument: true,
        }),
      }),
    );
    expect(mockSyncDocumentSafely).toHaveBeenCalledWith(makeDocument().id);
  });

  it("returns 200 without side effects when the document is already current", async () => {
    mockEnsureForWorkProduct.mockResolvedValue({
      document: makeDocument(),
      created: false,
      revisionChanged: false,
      remappedAnnotations: [],
    });

    const app = await createApp();
    const res = await request(app).post(
      `/api/issues/${ISSUE_ID}/work-products/${WORK_PRODUCT_ID}/review-document`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(makeDocument().id);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockSyncDocumentSafely).not.toHaveBeenCalled();
  });

  it("passes typed materialization errors through to the response", async () => {
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockEnsureForWorkProduct.mockRejectedValue(
      new HttpError(415, "Work product attachment is not Markdown"),
    );

    const app = await createApp();
    const res = await request(app).post(
      `/api/issues/${ISSUE_ID}/work-products/${WORK_PRODUCT_ID}/review-document`,
    );

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("Work product attachment is not Markdown");
  });

  it("resynchronizes an eligible review document after a title-only work product update", async () => {
    const renamed = makeWorkProduct({ title: "Renamed verification report" });
    mockWorkProductService.update.mockResolvedValue(renamed);
    mockEnsureForWorkProduct.mockResolvedValue({
      document: makeDocument({ title: "Renamed verification report", latestRevisionNumber: 2 }),
      created: false,
      revisionChanged: true,
      remappedAnnotations: [],
    });

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/work-products/${WORK_PRODUCT_ID}`)
      .send({ title: "Renamed verification report" });

    expect(res.status).toBe(200);
    expect(mockEnsureForWorkProduct).toHaveBeenCalledWith({
      issue: { id: ISSUE_ID, companyId: "company-1" },
      workProduct: renamed,
    });
  });
});
