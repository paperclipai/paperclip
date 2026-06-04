import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const parentUuid = "11111111-1111-4111-8111-111111111111";
const parentIdentifier = "PAP-4382";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  count: vi.fn(async () => 0),
  getByIdentifier: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async () => ({ allowed: true })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({ getById: vi.fn(async () => null) }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
  feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []) }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
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
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 200,
  clampIssueListLimit: (n: number) => Math.min(Math.max(n, 1), 200),
}));

async function createApp() {
  const { issueRoutes } = await vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", issueRoutes({} as any, {} as any));
  return app;
}

describe("GET /api/companies/:companyId/issues — parentId / descendantOf resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.count.mockResolvedValue(0);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
  });

  it("passes a UUID parentId straight to the service without consulting getByIdentifier", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ parentId: parentUuid });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ parentId: parentUuid }),
    );
  });

  it("resolves an identifier parentId to a UUID before calling the service", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce({ id: parentUuid, identifier: parentIdentifier } as never);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ parentId: parentIdentifier });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith(parentIdentifier);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ parentId: parentUuid }),
    );
  });

  it("returns 404 with parent_not_found when an identifier parentId does not resolve", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce(null);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ parentId: "PAP-99999999" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "parent_not_found", identifier: "PAP-99999999" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 with invalid_parent_id (echoing the trimmed value) for garbage parentId", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ parentId: "  not-a-uuid-or-identifier  " });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_parent_id", value: "not-a-uuid-or-identifier" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("resolves an identifier descendantOf to a UUID before calling the service", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce({ id: parentUuid, identifier: parentIdentifier } as never);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ descendantOf: parentIdentifier });

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith(parentIdentifier);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ descendantOf: parentUuid }),
    );
  });

  it("returns 404 with descendant_not_found when an identifier descendantOf does not resolve", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce(null);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ descendantOf: "PAP-99999999" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "descendant_not_found", identifier: "PAP-99999999" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 with invalid_descendant_of for garbage descendantOf", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ descendantOf: "lower-case-words" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_descendant_of", value: "lower-case-words" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("applies the same resolution to GET /issues/count", async () => {
    mockIssueService.getByIdentifier.mockResolvedValueOnce({ id: parentUuid, identifier: parentIdentifier } as never);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/issues/count")
      .query({ attention: "blocked", parentId: parentIdentifier });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith(parentIdentifier);
    expect(mockIssueService.count).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ parentId: parentUuid }),
    );
  });
});
