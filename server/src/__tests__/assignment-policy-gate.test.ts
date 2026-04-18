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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

// Stable UUIDs for each test agent
const ENGINEER_1  = "aaaa0001-0001-4001-8001-000000000001";
const QA_1        = "aaaa0002-0002-4002-8002-000000000002";
const CEO_1       = "aaaa0003-0003-4003-8003-000000000003";
const PAUSED_1    = "aaaa0004-0004-4004-8004-000000000004";
const CMO_1       = "aaaa0005-0005-4005-8005-000000000005";
const ENGINEER_2  = "aaaa0006-0006-4006-8006-000000000006";
const DEVOPS_1    = "aaaa0007-0007-4007-8007-000000000007";
const CROSS_1     = "aaaa0008-0008-4008-8008-000000000008";
const CTO_1       = "aaaa0009-0009-4009-8009-000000000009";
const NONEXISTENT = "aaaa0099-0099-4099-8099-000000000099";

const engineerAgent = {
  id: ENGINEER_1,
  companyId: "company-1",
  name: "Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const qaAgent = {
  id: QA_1,
  companyId: "company-1",
  name: "QA",
  role: "qa",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const ceoAgent = {
  id: CEO_1,
  companyId: "company-1",
  name: "CEO",
  role: "ceo",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: true },
};

const pausedAgent = {
  id: PAUSED_1,
  companyId: "company-1",
  name: "Paused",
  role: "qa",
  status: "paused",
  pauseReason: "manual",
  permissions: { canCreateAgents: false },
};

const cmoAgent = {
  id: CMO_1,
  companyId: "company-1",
  name: "CMO",
  role: "cmo",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const otherEngineer = {
  id: ENGINEER_2,
  companyId: "company-1",
  name: "Other Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const devopsAgent = {
  id: DEVOPS_1,
  companyId: "company-1",
  name: "Sr Platform Engineer",
  role: "devops",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const ctoAgent = {
  id: CTO_1,
  companyId: "company-1",
  name: "CTO",
  role: "cto",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: true },
};

const crossCompanyAgent = {
  id: CROSS_1,
  companyId: "other-company",
  name: "Cross Company",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const agentMap: Record<string, typeof engineerAgent> = {
  [ENGINEER_1]: engineerAgent,
  [QA_1]: qaAgent,
  [CEO_1]: ceoAgent,
  [PAUSED_1]: pausedAgent,
  [CMO_1]: cmoAgent,
  [ENGINEER_2]: otherEngineer,
  [DEVOPS_1]: devopsAgent,
  [CTO_1]: ctoAgent,
  [CROSS_1]: crossCompanyAgent,
};

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => agentMap[id] ?? null),
  }),
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
    wakeup: vi.fn(async () => undefined),
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
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ENGINEER_1,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  };
}

function createAgentApp(agentId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("assignment policy gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: QA_1, authorUserId: null },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  // --- Ownership ---

  it("engineer can reassign own issue to QA", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: QA_1, status: "in_review", comment: "Handing off to QA" });

    expect(res.status).toBe(200);
  });

  it("agent cannot reassign issue they do not own", async () => {
    const issue = makeIssue({ assigneeAgentId: QA_1, status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1 });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_ownership_required");
  });

  // --- Role matrix ---

  it("engineer cannot assign to CMO (not in allowed handoffs)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CMO_1, status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_role_not_allowed");
  });

  it("engineer can assign to devops (SPE) for infrastructure tasks", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: DEVOPS_1,
    });

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: DEVOPS_1, comment: "Needs SPE for VPS access" });

    expect(res.status).toBe(200);
  });

  it("devops (SPE) can assign to engineer for code handoff", async () => {
    const issue = makeIssue({ assigneeAgentId: DEVOPS_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: ENGINEER_1,
    });

    const res = await request(createAgentApp(DEVOPS_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1, comment: "Returning to engineer" });

    expect(res.status).toBe(200);
  });

  it("engineer can escalate to CTO (management escalation)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: CTO_1,
    });

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CTO_1, comment: "Escalating to CTO for decision" });

    expect(res.status).toBe(200);
  });

  it("devops can escalate to CEO (management escalation)", async () => {
    const issue = makeIssue({ assigneeAgentId: DEVOPS_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: CEO_1,
    });

    const res = await request(createAgentApp(DEVOPS_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CEO_1, comment: "Escalating to CEO" });

    expect(res.status).toBe(200);
  });

  it("QA can escalate to CTO (management escalation)", async () => {
    const issue = makeIssue({ assigneeAgentId: QA_1, status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: CTO_1,
    });

    const res = await request(createAgentApp(QA_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CTO_1, comment: "Escalating to CTO for guidance" });

    expect(res.status).toBe(200);
  });

  it("QA can return issue to engineer", async () => {
    const issue = makeIssue({ assigneeAgentId: QA_1, status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: ENGINEER_1,
      status: "in_progress",
    });

    const res = await request(createAgentApp(QA_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1, status: "in_progress", comment: "Returning for rework" });

    expect(res.status).toBe(200);
  });

  // --- Dispatchability ---

  it("cannot assign to paused agent", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: PAUSED_1, status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_dispatchable");
  });

  // --- Control-plane bypass ---

  it("CEO can reassign any issue regardless of ownership", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence from the acting agent (CEO_1)
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: CEO_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: CEO_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(CEO_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: QA_1, status: "in_review", comment: "Reassigning to QA" });

    expect(res.status).toBe(200);
  });

  it("CEO can assign to any role", async () => {
    const issue = makeIssue({ assigneeAgentId: CEO_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: CMO_1,
    });

    const res = await request(createAgentApp(CEO_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CMO_1, comment: "Assigning to CMO" });

    expect(res.status).toBe(200);
  });

  // --- Same-role lateral ---

  it("engineer cannot hand off to another engineer (same-role lateral)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_2 });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_role_not_allowed");
  });

  // --- Self-assignment (no-op) ---

  it("agent reassigning to self does not trigger assignment policy gate", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1 });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.assignment_policy_blocked" }),
    );
  });

  // --- Board bypass ---

  it("board user bypasses assignment policy entirely", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: CMO_1,
    });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CMO_1 });

    expect(res.status).toBe(200);
  });

  // --- Unassigned issue ---

  it("non-control-plane agent cannot claim unassigned issue", async () => {
    const issue = makeIssue({ assigneeAgentId: null, status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1 });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_ownership_required");
  });

  it("CEO can claim unassigned issue", async () => {
    const issue = makeIssue({ assigneeAgentId: null, status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: ENGINEER_1,
    });

    const res = await request(createAgentApp(CEO_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1, comment: "Assigning to engineer" });

    expect(res.status).toBe(200);
  });

  // --- Cross-company ---

  it("rejects assignment to agent in different company", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: CROSS_1, status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_found");
  });

  // --- Control-plane still blocked by dispatchability ---

  it("CEO cannot assign to paused agent", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(CEO_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: PAUSED_1, status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_dispatchable");
  });

  // --- Target not found ---

  it("rejects assignment to nonexistent agent", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: NONEXISTENT, status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_found");
  });

  // --- Activity logging ---

  it("logs policy rejection to activity log", async () => {
    const issue = makeIssue({ assigneeAgentId: QA_1, status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);

    await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: ENGINEER_1 });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.assignment_policy_blocked",
        entityId: issue.id,
      }),
    );
  });
});
