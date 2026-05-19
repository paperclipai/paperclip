import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "run-1";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  checkout: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getDefaultCompanyGoal: vi.fn(async () => null),
    getById: vi.fn(async () => null),
  }),
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
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp(agentId = AGENT_ID, runId = RUN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId,
      source: "agent_jwt",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "IUN-100",
    title: "Checkout guards test",
    projectId: PROJECT_ID,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
    ...overrides,
  };
}

describe("checkout paused project guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
  });

  it("rejects checkout with 409 when the project is paused for budget reasons", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: PROJECT_ID,
      pausedAt: new Date("2026-05-01T00:00:00Z"),
      pauseReason: "budget",
    });

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Project is paused because its budget hard-stop was reached");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("rejects checkout with 409 when the project is paused for a non-budget reason", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: PROJECT_ID,
      pausedAt: new Date("2026-05-01T00:00:00Z"),
      pauseReason: "manual",
    });

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Project is paused");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("allows checkout when the project is not paused", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: PROJECT_ID,
      pausedAt: null,
      pauseReason: null,
    });
    mockIssueService.checkout.mockResolvedValue(makeIssue({ status: "in_progress" }));

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });

  it("allows checkout when the issue has no project", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ projectId: null }));
    mockIssueService.checkout.mockResolvedValue(makeIssue({ status: "in_progress", projectId: null }));

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockProjectService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });
});

describe("checkout agent self-identity guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({ projectId: null }));
    mockProjectService.getById.mockResolvedValue(null);
  });

  it("blocks an agent from checking out as a different agent", async () => {
    const res = await request(createAgentApp(AGENT_ID, RUN_ID))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: OTHER_AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent can only checkout as itself");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("allows an agent to check out as itself", async () => {
    mockIssueService.checkout.mockResolvedValue(
      makeIssue({ status: "in_progress", projectId: null }),
    );

    const res = await request(createAgentApp(AGENT_ID, RUN_ID))
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });
});
