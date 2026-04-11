import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => false),
    hasPermission: vi.fn(async () => false),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-senior-engineer",
      companyId: "company-1",
      runId: null,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "agent-senior-engineer",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Blocked issue",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    requestDepth: 0,
    executionPolicy: null,
    executionState: null,
  };
}

function makeActorAgent() {
  return {
    id: "agent-senior-engineer",
    companyId: "company-1",
    role: "senior_engineer",
    name: "Senior Engineer",
    title: "Senior Engineer",
    adapterConfig: {
      issueBlockEscalation: {
        enabled: true,
        targetRole: "cto",
        openStatuses: ["todo", "in_progress", "blocked"],
      },
    },
  };
}

describe("issue blocked escalation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockAgentService.getById.mockResolvedValue(makeActorAgent());
    mockAgentService.list.mockResolvedValue([
      { id: "agent-cto", companyId: "company-1", role: "cto", name: "CTO", title: "CTO" },
    ]);
  });

  it("does not create an escalation child if the parent update fails", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockRejectedValue(new Error("update failed"));

    const res = await request(createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(500);
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.list).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.escalated" }),
    );
  });

  it("creates the escalation child only after the parent update succeeds", async () => {
    const issue = makeIssue();
    const escalationIssue = {
      ...issue,
      id: "22222222-2222-4222-8222-222222222222",
      identifier: "PAP-581",
      parentId: issue.id,
      originKind: "issue_escalation",
      assigneeAgentId: "agent-cto",
      status: "todo",
      title: "CTO escalation: PAP-580",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "blocked",
      updatedAt: new Date(),
    });
    mockIssueService.create.mockResolvedValue(escalationIssue);

    const res = await request(createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockIssueService.create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      parentId: issue.id,
      assigneeAgentId: "agent-cto",
    }));
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        parentId: issue.id,
        assigneeAgentId: "agent-cto",
        originKind: "issue_escalation",
      }),
    );
  });
});
