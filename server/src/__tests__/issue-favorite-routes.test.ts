import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  listFavoriteIssueIds: vi.fn(),
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
    accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
    agentService: () => ({ getById: vi.fn() }),
    companyService: () => ({ getById: vi.fn() }),
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
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ createForIssue: vi.fn(), getById: vi.fn(), update: vi.fn() }),
  }));
}

function noopStorage(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as never, noopStorage()));
  app.use(errorHandler);
  return app;
}

const BOARD_ACTOR = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

describe("issue favorite routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: "company-1" });
    mockIssueService.addFavorite.mockResolvedValue({ favoritedAt: new Date("2026-06-09T00:00:00.000Z") });
    mockIssueService.removeFavorite.mockResolvedValue(true);
    mockIssueService.listFavoriteIssueIds.mockResolvedValue([ISSUE_ID]);
  });

  it("adds a favorite for board users and logs the activity", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).post(`/api/issues/${ISSUE_ID}/favorite`).send({});

    expect(res.status).toBe(200);
    expect(res.body.favorited).toBe(true);
    expect(mockIssueService.addFavorite).toHaveBeenCalledWith("company-1", ISSUE_ID, "local-board", expect.any(Date));
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({ action: "issue.favorited", entityId: ISSUE_ID }),
    );
  });

  it("removes a favorite for board users", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).delete(`/api/issues/${ISSUE_ID}/favorite`);

    expect(res.status).toBe(200);
    expect(res.body.favorited).toBe(false);
    expect(mockIssueService.removeFavorite).toHaveBeenCalledWith("company-1", ISSUE_ID, "local-board");
  });

  it("lists favorite issue ids scoped to the company and user", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).get("/api/companies/company-1/favorites");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issueIds: [ISSUE_ID] });
    expect(mockIssueService.listFavoriteIssueIds).toHaveBeenCalledWith("company-1", "local-board");
  });

  it("returns 404 when favoriting a missing issue", async () => {
    mockIssueService.getById.mockResolvedValueOnce(null);
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).post(`/api/issues/${ISSUE_ID}/favorite`).send({});

    expect(res.status).toBe(404);
    expect(mockIssueService.addFavorite).not.toHaveBeenCalled();
  });

  it("rejects agent callers from toggling favorites", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).post(`/api/issues/${ISSUE_ID}/favorite`).send({});

    expect(res.status).toBe(403);
    expect(mockIssueService.addFavorite).not.toHaveBeenCalled();
  });

  it("rejects board users without access to the company list", async () => {
    const app = await createApp({ ...BOARD_ACTOR, source: "session", companyIds: ["company-2"] });

    const res = await request(app).get("/api/companies/company-1/favorites");

    expect(res.status).toBe(403);
    expect(mockIssueService.listFavoriteIssueIds).not.toHaveBeenCalled();
  });
});
