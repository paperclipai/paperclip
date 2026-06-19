import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { createUploadRateLimiter } from "../services/upload-rate-limit.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";
const UPLOAD_URL = `/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`;

const mockStorage = {
  provider: "local_disk" as const,
  putFile: vi.fn(async (input: {
    companyId: string;
    namespace: string;
    originalFilename?: string | null;
    contentType: string;
    body: Buffer;
  }) => ({
    provider: "local_disk" as const,
    objectKey: `${input.namespace}/file`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "sha256-sample",
    originalFilename: input.originalFilename ?? null,
  })),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  createAttachment: vi.fn(),
  getByIdentifier: vi.fn(),
  getAttachmentById: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  companyService: () => mockCompanyService,
  companySearchService: () => ({}),
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
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
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
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ createForIssue: vi.fn(), getById: vi.fn(), update: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 200,
  clampIssueListLimit: (n: number) => Math.min(n, 200),
}));

function setupIssueMocks() {
  mockIssueService.getById.mockResolvedValue({
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    identifier: "PAP-1",
  });
  mockCompanyService.getById.mockResolvedValue({
    id: COMPANY_ID,
    attachmentMaxBytes: 10 * 1024 * 1024,
  });
  mockIssueService.createAttachment.mockResolvedValue({
    id: "attachment-1",
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: `issues/${ISSUE_ID}/file.txt`,
    contentType: "text/plain",
    byteSize: 4,
    sha256: "sha256-sample",
    originalFilename: "file.txt",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function createApp(userId: string, rateLimiter: ReturnType<typeof createUploadRateLimiter>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId,
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as never, mockStorage as never, { uploadRateLimiter: rateLimiter }));
  return app;
}

describe("upload route rate limiting", () => {
  it("returns 201 and rate limit headers when under the limit", async () => {
    setupIssueMocks();
    mockStorage.putFile.mockClear();

    const app = createApp("user-1", createUploadRateLimiter({ maxRequests: 2, now: () => 1_000 }));
    const res = await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("1");
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("returns 429 with Retry-After header and body when over the limit", async () => {
    setupIssueMocks();
    mockStorage.putFile.mockClear();

    const app = createApp("user-1", createUploadRateLimiter({ maxRequests: 1, now: () => 1_000 }));

    await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    const limited = await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      error: "Upload rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["x-ratelimit-limit"]).toBe("1");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("allows requests again after the window resets", async () => {
    setupIssueMocks();
    mockStorage.putFile.mockClear();

    let fakeTime = 1_000;
    const app = createApp("user-1", createUploadRateLimiter({ maxRequests: 1, now: () => fakeTime }));

    await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    const limited = await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });
    expect(limited.status).toBe(429);

    fakeTime = 62_000;

    const reset = await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });
    expect(reset.status).toBe(201);
  });

  it("rate limits actors independently (actor A exhausted does not affect actor B)", async () => {
    setupIssueMocks();
    mockStorage.putFile.mockClear();

    const sharedLimiter = createUploadRateLimiter({ maxRequests: 1, now: () => 1_000 });
    let currentUserId = "user-a";
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: currentUserId,
        companyIds: [COMPANY_ID],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes({} as never, mockStorage as never, { uploadRateLimiter: sharedLimiter }));

    currentUserId = "user-a";
    await request(app).post(UPLOAD_URL).attach("file", Buffer.from("data"), { filename: "f.txt", contentType: "text/plain" });
    const limitedA = await request(app).post(UPLOAD_URL).attach("file", Buffer.from("data"), { filename: "f.txt", contentType: "text/plain" });
    expect(limitedA.status).toBe(429);

    currentUserId = "user-b";
    const allowedB = await request(app).post(UPLOAD_URL).attach("file", Buffer.from("data"), { filename: "f.txt", contentType: "text/plain" });
    expect(allowedB.status).toBe(201);
  });

  it("does not invoke storage when rate-limited (multer does not run)", async () => {
    setupIssueMocks();
    mockStorage.putFile.mockClear();

    const app = createApp("user-1", createUploadRateLimiter({ maxRequests: 1, now: () => 1_000 }));

    await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    const callsAfterFirstRequest = mockStorage.putFile.mock.calls.length;

    const limited = await request(app)
      .post(UPLOAD_URL)
      .attach("file", Buffer.from("data"), { filename: "file.txt", contentType: "text/plain" });

    expect(limited.status).toBe(429);
    expect(mockStorage.putFile.mock.calls.length).toBe(callsAfterFirstRequest);
  });
});
