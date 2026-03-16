import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  listMembers: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  getActiveCheckoutForIssueAgent: vi.fn(),
  recordReviewSubmission: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const mockRecordService = vi.hoisted(() => ({
  createBriefing: vi.fn(),
  addLink: vi.fn(),
  publish: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  approvalService: () => mockApprovalService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  recordService: () => mockRecordService,
  logActivity: mockLogActivity,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const RECORD_ID = "44444444-4444-4444-8444-444444444444";
const APPROVAL_ID = "55555555-5555-4555-8555-555555555555";

function createAgent(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "agent-1",
    companyId: COMPANY_ID,
    name: "Builder Bot",
    status: "running",
    reportsTo: "manager-1",
    permissions: { canCreateAgents: false, canAssignTasks: true },
    role: "manager",
    managerPlanningModeOverride: null,
    resolvedManagerPlanningMode: "automatic",
    ...overrides,
  };
}

function createIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    goalId: null,
    parentId: null,
    title: "Ship review workflow",
    description: "Add review handoff automation",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: "run-1",
    executionRunId: "run-1",
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    issueNumber: 12,
    identifier: "PAP-12",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    startedAt: new Date("2026-03-09T10:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: [],
    labels: [],
    createdAt: new Date("2026-03-09T09:00:00.000Z"),
    updatedAt: new Date("2026-03-09T10:00:00.000Z"),
    ...overrides,
  };
}

function createApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    companyId: COMPANY_ID,
    type: "approve_manager_plan",
    status: "approved",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    payload: {
      title: "Drive roadmap work",
      summary: "Start the next approved batch of work.",
    },
    createdAt: new Date("2026-03-09T09:00:00.000Z"),
    updatedAt: new Date("2026-03-09T10:00:00.000Z"),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, { deleteObject: vi.fn() } as any));
  app.use(errorHandler);
  return app;
}

describe("issue routes", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.listMembers.mockReset();
    mockAgentService.getById.mockReset();
    mockApprovalService.getById.mockReset();
    mockProjectService.getById.mockReset();
    mockGoalService.getById.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.getActiveCheckoutForIssueAgent.mockReset();
    mockHeartbeatService.recordReviewSubmission.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueApprovalService.link.mockReset();
    mockIssueApprovalService.unlink.mockReset();
    mockRecordService.createBriefing.mockReset();
    mockRecordService.addLink.mockReset();
    mockRecordService.publish.mockReset();
    mockLogActivity.mockReset();

    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({});
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.create.mockResolvedValue(
      createIssue({
        status: "backlog",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.listMembers.mockResolvedValue([
      {
        principalType: "user",
        principalId: "board-user",
        status: "active",
      },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-1") {
        return createAgent();
      }
      if (id === "manager-1") {
        return createAgent({
          id: "manager-1",
          name: "Engineering Manager",
          status: "idle",
          reportsTo: null,
        });
      }
      return null;
    });
    mockApprovalService.getById.mockResolvedValue(createApproval());
    mockProjectService.getById.mockResolvedValue({
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      leadAgentId: "manager-1",
    });
    mockRecordService.createBriefing.mockResolvedValue({
      id: RECORD_ID,
      companyId: COMPANY_ID,
      category: "briefing",
      kind: "daily_briefing",
      scopeType: "project",
      scopeRefId: PROJECT_ID,
    });
    mockRecordService.addLink.mockResolvedValue({});
    mockRecordService.publish.mockResolvedValue({
      id: RECORD_ID,
      companyId: COMPANY_ID,
      category: "briefing",
      kind: "daily_briefing",
      status: "published",
    });
    mockHeartbeatService.getActiveCheckoutForIssueAgent.mockResolvedValue(null);
    mockHeartbeatService.recordReviewSubmission.mockResolvedValue({
      id: "checkout-1",
    });
  });

  it("turns an agent completion into an in-review handoff and creates a briefing", async () => {
    const existing = createIssue();
    const updated = createIssue({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      checkoutRunId: null,
      updatedAt: new Date("2026-03-09T11:00:00.000Z"),
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      body: "Implemented the review handoff.\nAdded route coverage.",
      authorAgentId: "agent-1",
      authorUserId: null,
      createdAt: new Date("2026-03-09T11:00:00.000Z"),
      updatedAt: new Date("2026-03-09T11:00:00.000Z"),
    });

    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "done",
        comment: "Implemented the review handoff.\nAdded route coverage.",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "board-user",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "Implemented the review handoff.\nAdded route coverage.",
      { agentId: "agent-1", userId: undefined },
    );
    expect(mockRecordService.createBriefing).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        kind: "daily_briefing",
        scopeType: "project",
        scopeRefId: PROJECT_ID,
        ownerAgentId: "agent-1",
      }),
      { agentId: "agent-1", userId: null },
    );
    expect(mockRecordService.publish).toHaveBeenCalledWith(RECORD_ID, {
      agentId: "agent-1",
      userId: null,
    });
  });

  it("rejects agent review handoffs without a summary comment", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue());
    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("handoff update");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockRecordService.createBriefing).not.toHaveBeenCalled();
  });

  it("requires review submission metadata for repo-backed review handoffs", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue());
    mockHeartbeatService.getActiveCheckoutForIssueAgent.mockResolvedValue({
      id: "checkout-1",
      issueId: ISSUE_ID,
      agentId: "agent-1",
      branchName: "codex/paperclip/agent-1/pap-12",
      worktreePath: "/tmp/worktree",
    });
    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "done",
        comment: "Ready for review.",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("reviewSubmission");
    expect(mockHeartbeatService.recordReviewSubmission).not.toHaveBeenCalled();
  });

  it("persists repo review submission metadata and appends it to the handoff comment", async () => {
    const existing = createIssue();
    const updated = createIssue({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      checkoutRunId: null,
      updatedAt: new Date("2026-03-09T11:00:00.000Z"),
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: ISSUE_ID,
      body: "Ready for review.\n\n## Review Submission\n\n- Branch: codex/paperclip/agent-1/pap-12\n- Head commit: abc123\n- Pull request: https://github.com/paperclipai/paperclip/pull/42",
      authorAgentId: "agent-1",
      authorUserId: null,
      createdAt: new Date("2026-03-09T11:00:00.000Z"),
      updatedAt: new Date("2026-03-09T11:00:00.000Z"),
    });
    mockHeartbeatService.getActiveCheckoutForIssueAgent.mockResolvedValue({
      id: "checkout-1",
      issueId: ISSUE_ID,
      agentId: "agent-1",
      branchName: "codex/paperclip/agent-1/pap-12",
      worktreePath: "/tmp/worktree",
    });

    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "done",
        comment: "Ready for review.",
        reviewSubmission: {
          checkoutId: "66666666-6666-4666-8666-666666666666",
          branchName: "codex/paperclip/agent-1/pap-12",
          headCommitSha: "abc123",
          pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/42",
        },
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.recordReviewSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        agentId: "agent-1",
        branchName: "codex/paperclip/agent-1/pap-12",
        headCommitSha: "abc123",
        pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/42",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.stringContaining("## Review Submission"),
      { agentId: "agent-1", userId: undefined },
    );
  });

  it("rejects review submissions before checkout metadata is persisted when checkout ownership fails", async () => {
    mockIssueService.getById.mockResolvedValue(createIssue());
    mockIssueService.assertCheckoutOwner.mockRejectedValueOnce(
      conflict("Issue run ownership conflict"),
    );
    mockHeartbeatService.getActiveCheckoutForIssueAgent.mockResolvedValue({
      id: "checkout-1",
      issueId: ISSUE_ID,
      agentId: "agent-1",
      branchName: "codex/paperclip/agent-1/pap-12",
      worktreePath: "/tmp/worktree",
    });

    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "done",
        comment: "Ready for review.",
        reviewSubmission: {
          checkoutId: "66666666-6666-4666-8666-666666666666",
          branchName: "codex/paperclip/agent-1/pap-12",
          headCommitSha: "abc123",
          pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/42",
        },
      });

    expect(res.status).toBe(409);
    expect(mockHeartbeatService.recordReviewSubmission).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects top-level issue creation without approval in approval-required mode", async () => {
    mockAgentService.getById.mockResolvedValueOnce(
      createAgent({ resolvedManagerPlanningMode: "approval_required" }),
    );
    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Start roadmap work" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("approvalId is required");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "approval belongs to another company",
      createApproval({ companyId: "99999999-9999-4999-8999-999999999999" }),
      403,
      "another company",
    ],
    [
      "approval was requested by another agent",
      createApproval({ requestedByAgentId: "manager-1" }),
      403,
      "not requested by this agent",
    ],
    [
      "approval is still pending",
      createApproval({ status: "pending" }),
      422,
      "must be approved",
    ],
  ])(
    "rejects top-level issue creation when %s",
    async (_label, approval, expectedStatus, expectedMessage) => {
      mockAgentService.getById.mockResolvedValueOnce(
        createAgent({ resolvedManagerPlanningMode: "approval_required" }),
      );
      mockApprovalService.getById.mockResolvedValueOnce(approval);
      const app = createApp({
        type: "agent",
        source: "agent_key",
        companyId: COMPANY_ID,
        agentId: "agent-1",
        runId: "run-1",
      });

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/issues`)
        .send({ title: "Start roadmap work", approvalId: APPROVAL_ID });

      expect(res.status).toBe(expectedStatus);
      expect(res.body.error).toContain(expectedMessage);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    },
  );

  it("links approved manager-plan approvals to new top-level issues", async () => {
    mockAgentService.getById.mockResolvedValueOnce(
      createAgent({ resolvedManagerPlanningMode: "approval_required" }),
    );
    mockApprovalService.getById.mockResolvedValueOnce(createApproval());
    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        title: "Start roadmap work",
        description: "Turn the approved plan into tracked work.",
        approvalId: APPROVAL_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        title: "Start roadmap work",
        description: "Turn the approved plan into tracked work.",
        createdByAgentId: "agent-1",
        createdByUserId: null,
      }),
    );
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("approvalId");
    expect(mockIssueApprovalService.link).toHaveBeenCalledWith(ISSUE_ID, APPROVAL_ID, {
      agentId: "agent-1",
      userId: null,
    });
  });

  it("allows sub-issues without a new planning approval", async () => {
    mockAgentService.getById.mockResolvedValueOnce(
      createAgent({ resolvedManagerPlanningMode: "approval_required" }),
    );
    const app = createApp({
      type: "agent",
      source: "agent_key",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        title: "Break approved work into a sub-task",
        parentId: ISSUE_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
  });

  it("passes parentId filters through to the issue service list call", async () => {
    const app = createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/issues`)
      .query({ parentId: ISSUE_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        parentId: ISSUE_ID,
      }),
    );
  });
});
