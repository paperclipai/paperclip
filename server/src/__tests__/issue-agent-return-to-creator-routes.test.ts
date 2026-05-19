import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATOR_USER_ID = "creator-user-1";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-agent-1";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
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
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createAppAsAgent(agentId = AGENT_ID, runId = RUN_ID) {
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

function makeInProgressIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: CREATOR_USER_ID,
    checkoutRunId: RUN_ID,
    executionRunId: RUN_ID,
    identifier: "IUN-999",
    title: "Agent return to creator test",
    projectId: null,
    ...overrides,
  };
}

describe("agent returning issue to creator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeInProgressIssue(),
      ...patch,
    }));
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: ISSUE_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_ID,
      checkoutRunId: RUN_ID,
      adoptedFromRunId: null,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    // By default deny tasks:assign — proves returning-to-creator bypasses permission check
    mockAccessService.hasPermission.mockResolvedValue(false);
    // Non-CEO agent (no canCreateAgents)
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-1",
      role: "engineer",
      permissions: {},
    });
  });

  it("allows an agent to return an in_progress issue to its creator without tasks:assign permission", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());

    const res = await request(createAppAsAgent())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null, assigneeUserId: CREATOR_USER_ID });

    expect(res.status).toBe(200);
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        assigneeAgentId: null,
        assigneeUserId: CREATOR_USER_ID,
        assignedByAgentId: AGENT_ID,
        assignedByUserId: null,
      }),
    );
  });

  it("blocks an agent from reassigning to a non-creator user without tasks:assign permission", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue());

    const res = await request(createAppAsAgent())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null, assigneeUserId: "some-other-user" });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks an agent that is not the current assignee from returning to creator without tasks:assign permission", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue({ assigneeAgentId: OTHER_AGENT_ID }));

    const res = await request(createAppAsAgent())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null, assigneeUserId: CREATOR_USER_ID });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks the return-to-creator path when the issue has no createdByUserId", async () => {
    mockIssueService.getById.mockResolvedValue(makeInProgressIssue({ createdByUserId: null }));

    const res = await request(createAppAsAgent())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null, assigneeUserId: CREATOR_USER_ID });

    // isAgentReturningIssueToCreator is false because createdByUserId is null,
    // so assertCanAssignTasks is invoked and blocks the request.
    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
