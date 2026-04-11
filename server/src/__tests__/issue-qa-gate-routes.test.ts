import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  listComments: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
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
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
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
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

const mockDb = {} as any;

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-901",
    title: "Ship candidate",
    description: null,
    status,
    priority: "medium",
    assigneeAgentId: "agent-engineer",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    executionState: {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
    createdAt: new Date("2026-04-10T00:00:00Z"),
    updatedAt: new Date("2026-04-10T00:00:00Z"),
  };
}

function qaComment(body: string) {
  return {
    id: "comment-qa",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId: "agent-qa",
    authorUserId: null,
    body,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    updatedAt: new Date("2026-04-10T10:00:00Z"),
  };
}

describe("issue QA gate routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-auto-fix",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "auto-fix",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });
  });

  it("rejects delivery issue done transition when current status is not in_review", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_in_review",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when latest QA comment is missing [QA PASS]", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_review"));
    mockIssueService.listComments.mockResolvedValue([qaComment("QA checked basics only")]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_pass",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when latest QA comment is missing [RELEASE CONFIRMED]", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_review"));
    mockIssueService.listComments.mockResolvedValue([qaComment("[QA PASS]\nNeeds release check")]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_release_confirmation",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows delivery issue done transition when latest QA comment has both markers", async () => {
    const existing = makeIssue("in_review");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([qaComment("[QA PASS]\n[RELEASE CONFIRMED]")]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("supports board-only forceDone override with overrideReason", async () => {
    const existing = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "Urgent customer unblock" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("returns invalid_status_transition reason codes from 422 route errors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(() => {
      throw new HttpError(422, "Invalid issue status transition", {
        reasonCode: "invalid_status_transition",
      });
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "invalid_status_transition",
    });
  });

  it("rejects forceDone override for non-board actors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "No gate needed" });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns qaGate fields from issue detail payload", async () => {
    const existing = makeIssue("in_review");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:warn] [TC:fail] [CM:pass] [DOC:na]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.qaGate).toMatchObject({
      isDeliveryScoped: true,
      canShip: true,
      missingRequirements: [],
      review: {
        codeQuality: "pass",
        errorHandling: "warn",
        testCoverage: "fail",
        commentQuality: "pass",
        docsImpact: "na",
        overall: "fail",
      },
    });
  });

  it("returns qaGate for in_review issues in company list responses", async () => {
    mockIssueService.list.mockResolvedValue([makeIssue("in_review")]);
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]?.qaGate).toMatchObject({
      canShip: true,
      review: { overall: "pass" },
    });
  });

  it("triggers bounded auto-fix attempts for in_review fail synthesis", async () => {
    const existing = makeIssue("in_review");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      priority: "high",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-engineer",
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });
});
