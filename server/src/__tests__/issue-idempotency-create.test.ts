import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /companies/:cid/issues Idempotency guard (Kuromi DGG-2612 / 2026-04-19)
// Guards two paths:
//   1) Idempotency-Key request header -> in-memory 10min replay cache
//   2) (title normalized + parentId + projectId + assigneeAgentId) 24h active
//      duplicate search -> returns existing issue with X-Idempotent-Replay=fingerprint.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  findActiveDuplicate: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  queueIssueAssignmentWakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => mockGoalService,
    heartbeatService: () => mockHeartbeatService,
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
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, issuesModule] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  if (typeof (issuesModule as any).__resetIdempotencyCacheForTests === "function") {
    (issuesModule as any).__resetIdempotencyCacheForTests();
  }
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
  app.use("/api", issuesModule.issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /issues idempotency guard (DGG-2612)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_IDEMPOTENCY_GUARD;
    mockIssueService.findActiveDuplicate.mockResolvedValue(null);
    mockIssueService.create.mockImplementation(async (_cid: string, body: Record<string, unknown>) => ({
      id: "new-issue-id",
      companyId: "company-1",
      identifier: "DGG-1000",
      status: "todo",
      ...body,
    }));
  });

  it("creates a new issue when no idempotency key and no fingerprint match", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Brand new work item" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);
    expect(res.headers["x-idempotent-replay"]).toBeUndefined();
  });

  it("replays from the Idempotency-Key cache on a second matching POST", async () => {
    const app = await createApp();

    const first = await request(app)
      .post("/api/companies/company-1/issues")
      .set("Idempotency-Key", "abc-123")
      .send({ title: "Key-scoped dedupe" });
    expect(first.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post("/api/companies/company-1/issues")
      .set("Idempotency-Key", "abc-123")
      .send({ title: "Key-scoped dedupe" });
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("key");
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);
    expect(second.body.id).toBe(first.body.id);
  });

  it("returns the existing issue with X-Idempotent-Replay=fingerprint when findActiveDuplicate hits", async () => {
    mockIssueService.findActiveDuplicate.mockResolvedValueOnce({
      id: "existing-issue-id",
      companyId: "company-1",
      identifier: "DGG-777",
      status: "in_progress",
      title: "Duplicate fingerprint",
    });
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Duplicate fingerprint", parentId: null, projectId: null });

    expect(res.status).toBe(200);
    expect(res.headers["x-idempotent-replay"]).toBe("fingerprint");
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(res.body.id).toBe("existing-issue-id");
  });

  it("does not dedupe when env toggle PAPERCLIP_IDEMPOTENCY_GUARD=off", async () => {
    process.env.PAPERCLIP_IDEMPOTENCY_GUARD = "off";
    mockIssueService.findActiveDuplicate.mockResolvedValueOnce({
      id: "should-not-be-used",
      title: "Would have matched",
    });
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .set("Idempotency-Key", "should-not-matter")
      .send({ title: "Would have matched" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);
    expect(mockIssueService.findActiveDuplicate).not.toHaveBeenCalled();
    expect(res.headers["x-idempotent-replay"]).toBeUndefined();
  });


});
