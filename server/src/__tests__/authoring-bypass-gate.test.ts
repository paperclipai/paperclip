import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// Verifies the narrow `tickets:bypass_authoring_gates` permission grants
// relief from authoring/coordination gates while preserving delivery, QA,
// dispatchability, and other governance checks.

const DEPT_ENG_LABEL_ID = "d0000000-0000-4000-8000-000000000001";

const MONITOR_AGENT_ID = "aaaa0001-0001-4001-8001-000000000001";
const LEADER_AGENT_ID = "aaaa0002-0002-4002-8002-000000000002";
const ENGINEER_AGENT_ID = "aaaa0003-0003-4003-8003-000000000003";
const QA_AGENT_ID = "aaaa0004-0004-4004-8004-000000000004";
const PAUSED_AGENT_ID = "aaaa0005-0005-4005-8005-000000000005";
const PARENT_INITIATIVE_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_SIBLING_ID = "22222222-2222-4222-8222-222222222222";

const monitorAgent = {
  id: MONITOR_AGENT_ID,
  companyId: "company-1",
  name: "Monitor",
  role: "devops",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const engineerAgent = {
  id: ENGINEER_AGENT_ID,
  companyId: "company-1",
  name: "Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const qaAgent = {
  id: QA_AGENT_ID,
  companyId: "company-1",
  name: "QA",
  role: "qa",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const pausedAgent = {
  id: PAUSED_AGENT_ID,
  companyId: "company-1",
  name: "Paused",
  role: "qa",
  status: "paused",
  pauseReason: "manual",
  permissions: { canCreateAgents: false },
};

const parentInitiative = {
  id: PARENT_INITIATIVE_ID,
  issueType: "initiative",
  companyId: "company-1",
};

const agentMap: Record<string, typeof monitorAgent> = {
  [MONITOR_AGENT_ID]: monitorAgent,
  [LEADER_AGENT_ID]: { ...monitorAgent, id: LEADER_AGENT_ID, role: "ceo", name: "CEO" },
  [ENGINEER_AGENT_ID]: engineerAgent,
  [QA_AGENT_ID]: qaAgent,
  [PAUSED_AGENT_ID]: pausedAgent,
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(async () => []),
  hasReachedStatus: vi.fn(),
  countRecentByAgent: vi.fn(async () => 0),
  getDepartmentLabelIds: vi.fn(),
  findDepartmentDuplicate: vi.fn(async () => null),
  getIssueTypeById: vi.fn(async () => parentInitiative),
  getLabelsByIssueId: vi.fn(async () => []),
  list: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

// Make the bypass permission controllable from the test.
const mockHasPermission = vi.hoisted(() =>
  vi.fn(async (_c: string, _kind: string, id: string, key: string) => {
    if (key === "tickets:bypass_authoring_gates") return id === MONITOR_AGENT_ID;
    return true;
  }),
);

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: mockHasPermission,
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => agentMap[id] ?? null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
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

function makeCreatedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    identifier: "PAP-900",
    title: "Created",
    description: null,
    status: "backlog",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: MONITOR_AGENT_ID,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-18T17:00:00Z"),
    ...overrides,
  };
}

function makeExistingIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: PARENT_INITIATIVE_ID,
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Host",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ENGINEER_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-18T17:00:00Z"),
    ...overrides,
  };
}

describe("authoring bypass — tickets:bypass_authoring_gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(new Set([DEPT_ENG_LABEL_ID]));
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
    mockIssueService.getIssueTypeById.mockResolvedValue(parentInitiative);
    mockIssueService.addComment.mockResolvedValue({ id: "c1", body: "ok" });
    mockHasPermission.mockImplementation(async (_c: string, _kind: string, id: string, key: string) => {
      if (key === "tickets:bypass_authoring_gates") return id === MONITOR_AGENT_ID;
      return true;
    });
  });

  // ---------- department_label_required ----------

  it("bypass agent creates issue WITHOUT dept label → 201", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "Platform health scan alert", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("non-bypass agent creates issue WITHOUT dept label → 422", async () => {
    const res = await request(createAgentApp(LEADER_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "Some initiative", issueType: "initiative" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("department_label_required");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  // ---------- initiative_requires_leadership_role ----------

  it("bypass agent (non-leadership role) creates initiative → 201", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "Platform Health", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
  });

  it("non-bypass non-leadership agent creating initiative → 422", async () => {
    const res = await request(createAgentApp(ENGINEER_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "Engineer's initiative", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_requires_leadership_role");
  });

  // ---------- initiative_title_looks_like_task ----------

  it("bypass agent creates initiative titled 'fix X' → 201", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "fix adapter_failed recurrence", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
  });

  it("non-bypass leadership agent with task-shaped title → 422", async () => {
    const res = await request(createAgentApp(LEADER_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "fix adapter_failed recurrence", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_title_looks_like_task");
  });

  // ---------- relay_duplication_blocker ----------

  it("bypass agent re-files a sibling repair under same parent → 201", async () => {
    // findDepartmentDuplicate default is null; the inline parent-sibling dedup uses issueService.list or a raw DB select.
    // Server code uses db.select directly on issues table. In this test, sibling lookup runs against the mocked db passed
    // as "{} as any" to the route factory; its behavior is undefined. To avoid relying on that, simulate the sibling
    // query short-circuiting by leaving the dedup db off; the bypass short-circuit happens BEFORE the db.select runs.
    mockIssueService.create.mockResolvedValue(makeCreatedIssue({ parentId: PARENT_INITIATIVE_ID }));
    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({
        title: "repair deploy stale lock",
        issueType: "task",
        parentId: PARENT_INITIATIVE_ID,
        labelIds: [DEPT_ENG_LABEL_ID],
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  // ---------- assignment_policy: ownership + role matrix ----------

  it("bypass agent reassigns an issue it does NOT own → 200", async () => {
    const other = makeExistingIssue({ assigneeAgentId: ENGINEER_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(other);
    mockIssueService.update.mockResolvedValue({ ...other, assigneeAgentId: QA_AGENT_ID });

    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .patch(`/api/issues/${other.id}`)
      .send({ assigneeAgentId: QA_AGENT_ID, comment: "Monitor: routing to QA for review." });

    expect(res.status).toBe(200);
  });

  it("bypass agent CANNOT assign to a paused agent (dispatchability preserved) → 422", async () => {
    const own = makeExistingIssue({ assigneeAgentId: MONITOR_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(own);

    const res = await request(createAgentApp(MONITOR_AGENT_ID))
      .patch(`/api/issues/${own.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID, comment: "routing" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_dispatchable");
  });

  // ---------- telemetry ----------

  it("logs issue.authoring_bypass_used when bypass actually fires", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    await request(createAgentApp(MONITOR_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "no-label repair", issueType: "initiative" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.authoring_bypass_used",
        agentId: MONITOR_AGENT_ID,
        details: expect.objectContaining({ gate: expect.any(String) }),
      }),
    );
  });

  it("does NOT log bypass when issue creation satisfies gates organically", async () => {
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    await request(createAgentApp(LEADER_AGENT_ID))
      .post("/api/companies/company-1/issues")
      .send({ title: "Proper initiative", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    const bypassCalls = mockLogActivity.mock.calls.filter(
      ([, payload]: [unknown, { action?: string }]) => payload?.action === "issue.authoring_bypass_used",
    );
    expect(bypassCalls.length).toBe(0);
  });
});
