import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
  hasReachedStatus: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockHeartbeatWakeup = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockHeartbeatWakeup,
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => ({ contextSnapshot: {} })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Test issue",
    description: null,
    status: "done",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago (within reopen window)
    ...overrides,
  };
}

function makeAgent(role: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    role,
    permissions: { canCreateAgents: role === "ceo" },
    ...overrides,
  };
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("reopen gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatWakeup.mockResolvedValue(undefined);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  describe("direct status change (done → in_progress)", () => {
    it("CEO agent can reopen done → in_progress with valid payload", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopening due to user objection",
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence/123",
        });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issue.id,
        expect.objectContaining({ status: "in_progress" }),
      );
    });

    it("CTO agent can reopen done → in_progress with valid payload", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });
      mockAgentService.getById.mockResolvedValue(makeAgent("cto"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "QA retraction",
          reopenReasonCode: "qa_retraction",
          reopenEvidence: "comment-id-456",
        });

      expect(res.status).toBe(200);
    });

    it("QA agent can reopen done → todo with valid payload", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "todo" });
      mockAgentService.getById.mockResolvedValue(makeAgent("qa"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "todo",
          comment: "Regression found",
          reopenReasonCode: "prod_regression",
          reopenEvidence: "https://example.com/bug/789",
        });

      expect(res.status).toBe(200);
    });

    it("engineer agent is blocked from reopening done tasks", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("engineer"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Trying to reopen",
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_agent_transition");
      expect(res.body.error).toContain("Only CEO, CTO, or QA");
    });

    it("reopen blocked without reopenReasonCode", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("reopen_missing_reason");
    });

    it("reopen blocked without reopenEvidence", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
          reopenReasonCode: "user_rejected",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("reopen_missing_evidence");
    });

    it("reopen blocked after 48h window expires", async () => {
      const issue = makeIssue({ updatedAt: new Date("2026-04-01T00:00:00Z") });
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("reopen_window_expired");
      expect(res.body.error).toContain("48-hour");
    });

    it("cancelled status remains immutable for all agents", async () => {
      const issue = makeIssue({ status: "cancelled" });
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_agent_transition");
    });
  });

  describe("reopen via flag (reopen: true)", () => {
    it("CEO agent can reopen done tasks via reopen flag with valid payload", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "todo" });
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "Reopening via flag",
          reopen: true,
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issue.id,
        expect.objectContaining({ status: "todo" }),
      );
    });

    it("QA agent can reopen done tasks via reopen flag with valid payload", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "todo" });
      mockAgentService.getById.mockResolvedValue(makeAgent("qa"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "QA retraction",
          reopen: true,
          reopenReasonCode: "qa_retraction",
          reopenEvidence: "comment-456",
        });

      expect(res.status).toBe(200);
    });

    it("engineer agent is blocked from reopen flag on done tasks", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("engineer"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "Trying to reopen",
          reopen: true,
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_agent_transition");
    });

    it("reopen flag blocked without reason code", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "Reopen",
          reopen: true,
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("reopen_missing_reason");
    });

    it("cancelled tasks remain blocked for agents even via reopen flag", async () => {
      const issue = makeIssue({ status: "cancelled" });
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("ceo"));

      const res = await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          comment: "Reopen",
          reopen: true,
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_agent_transition");
    });
  });

  describe("audit trail", () => {
    it("logs issue.reopened event on successful privileged reopen", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });
      mockAgentService.getById.mockResolvedValue(makeAgent("qa"));

      await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "QA retraction after finding regression",
          reopenReasonCode: "qa_retraction",
          reopenEvidence: "https://example.com/regression/42",
        });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.reopened",
          entityType: "issue",
          entityId: issue.id,
          details: expect.objectContaining({
            reopenedFrom: "done",
            reopenedTo: "in_progress",
            reopenReasonCode: "qa_retraction",
            reopenEvidence: "https://example.com/regression/42",
            reopenAgentRole: "qa",
          }),
        }),
      );
    });

    it("logs reopen details in issue.updated event", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });
      mockAgentService.getById.mockResolvedValue(makeAgent("cto"));

      await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
          reopenReasonCode: "prod_regression",
          reopenEvidence: "https://example.com/incident",
        });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.updated",
          details: expect.objectContaining({
            reopened: true,
            reopenedFrom: "done",
            reopenReasonCode: "prod_regression",
            reopenEvidence: "https://example.com/incident",
            reopenAgentRole: "cto",
          }),
        }),
      );
    });

    it("logs transition_blocked when unprivileged agent tries to reopen", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentService.getById.mockResolvedValue(makeAgent("devops"));

      await request(createAgentApp())
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "in_progress",
          comment: "Reopen",
          reopenReasonCode: "user_rejected",
          reopenEvidence: "https://example.com/evidence",
        });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.transition_blocked",
          details: expect.objectContaining({
            gate: "invalid_agent_transition",
            fromStatus: "done",
            targetStatus: "in_progress",
          }),
        }),
      );
    });
  });
});
