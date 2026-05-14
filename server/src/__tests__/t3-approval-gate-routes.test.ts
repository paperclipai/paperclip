import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(() => Promise.resolve({ unresolvedBlockerCount: 0 })),
  findMentionedAgents: vi.fn(() => Promise.resolve([])),
  listWakeableBlockedDependents: vi.fn(() => Promise.resolve([])),
  getWakeableParentAfterChildCompletion: vi.fn(() => Promise.resolve(null)),
  checkout: vi.fn(),
  getRelationSummaries: vi.fn(() => Promise.resolve([])),
  list: vi.fn(() => Promise.resolve([])),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
  linkManyForApproval: vi.fn(async () => undefined),
  link: vi.fn(async () => null),
  unlink: vi.fn(async () => undefined),
  listIssuesForApproval: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  list: vi.fn(async () => []),
  resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  diffIssueReferenceSummary: vi.fn(() => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] })),
  syncIssue: vi.fn(async () => undefined),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  updateIssueReferenceSummary: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: any) => fn(mockTx)),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));
vi.mock("./issues-checkout-wakeup.js", () => ({ shouldWakeAssigneeOnCheckout: vi.fn(() => false) }));
vi.mock("./environment-selection.js", () => ({ assertEnvironmentSelectionForCompany: vi.fn() }));
vi.mock("./workspace-command-authz.js", () => ({
  assertNoAgentHostWorkspaceCommandMutation: vi.fn(),
  collectIssueWorkspaceCommandPaths: vi.fn(() => []),
}));
vi.mock("../services/issue-execution-policy.js", () => ({
  applyIssueExecutionPolicyTransition: vi.fn(() => ({ patch: {}, decision: null, workflowControlledAssignment: false })),
  normalizeIssueExecutionPolicy: vi.fn(() => null),
  parseIssueExecutionState: vi.fn(() => null),
}));
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));

// Single barrel mock for all services
vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  clampIssueListLimit: (v: number) => v,
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentService: () => ({
    getByKey: vi.fn(async () => null),
  }),
  extractLegacyPlanBody: () => null,
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
    getActiveForIssue: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({ getById: vi.fn(async () => null) }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY: "continuation-summary",
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 500,
  issueApprovalService: () => mockIssueApprovalService,
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({ getById: vi.fn(async () => null) }),
  routineService: () => mockRoutineService,
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

const T3_DESCRIPTION_NO_APPROVAL = `\`\`\`markdown
Authority Classification:
T3

T3 Trigger Check:
- Security-sensitive: Yes
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
(Required if Approval Required = Yes)

Decision Packet Required:
No
\`\`\``;

const T3_DESCRIPTION_WITH_APPROVAL = `\`\`\`markdown
Authority Classification:
T3

T3 Trigger Check:
- Security-sensitive: Yes
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
apr-granted-id-123

Decision Packet Required:
No
\`\`\``;

const T2_DESCRIPTION = `\`\`\`markdown
Authority Classification:
T2

T3 Trigger Check:
- Security-sensitive: No
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
(Dranak to approve at review)

Decision Packet Required:
No
\`\`\``;

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "DRA-999",
    title: "Test issue",
    status: "todo",
    description: "",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 999,
    requestDepth: 0,
    billingCode: null,
    executionPolicy: null,
    executionState: null,
    executionRunId: null,
    checkoutRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    workMode: "standard",
    priority: "medium",
    projectWorkspaceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    labels: [],
    ...overrides,
  };
}

async function createAgentApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("T3 gate: PATCH /issues/:id status transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
  });

  it("blocks T3 issue status transition to in_progress when no approved board approval exists", async () => {
    const app = await createAgentApp();
    const issue = makeIssue({ status: "todo", description: T3_DESCRIPTION_NO_APPROVAL });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer test-token")
      .set("X-Paperclip-Run-Id", "run-1")
      .send({ status: "in_progress" });

    if (res.status !== 422) {
      throw new Error(`Expected 422 but got ${res.status}. Body: ${JSON.stringify(res.body)}`);
    }
    expect((res.body as { code?: string }).code).toBe("t3_gate_violation");
  });

  it("allows T3 issue status transition when an approved board approval exists", async () => {
    const app = await createAgentApp();
    const issue = makeIssue({ status: "todo", description: T3_DESCRIPTION_WITH_APPROVAL });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved" },
    ]);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress", labels: [] });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer test-token")
      .set("X-Paperclip-Run-Id", "run-1")
      .send({ status: "in_progress" });

    expect(res.status).not.toBe(422);
  });

  it("does NOT block T2 issue status transitions (regression: T1/T2 unaffected)", async () => {
    const app = await createAgentApp();
    const issue = makeIssue({ status: "todo", description: T2_DESCRIPTION });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress", labels: [] });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer test-token")
      .set("X-Paperclip-Run-Id", "run-1")
      .send({ status: "in_progress" });

    const body = res.body as { code?: string };
    if (res.status === 422) {
      expect(body.code).not.toBe("t3_gate_violation");
    }
    // Gate should not check approvals for T2
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("does NOT block T3 transitions to blocked status (marking blocked stays allowed)", async () => {
    const app = await createAgentApp();
    const issue = makeIssue({ status: "todo", description: T3_DESCRIPTION_NO_APPROVAL });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "blocked", labels: [] });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer test-token")
      .set("X-Paperclip-Run-Id", "run-1")
      .send({ status: "blocked" });

    const body = res.body as { code?: string };
    if (res.status === 422) {
      expect(body.code).not.toBe("t3_gate_violation");
    }
  });

  it("does NOT check gate when todo->todo (no status escape from backlog/todo)", async () => {
    const app = await createAgentApp();
    const issue = makeIssue({ status: "backlog", description: T3_DESCRIPTION_NO_APPROVAL });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "todo", labels: [] });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer test-token")
      .set("X-Paperclip-Run-Id", "run-1")
      .send({ status: "todo" });

    // Gate should NOT fire for todo/backlog-to-todo transitions
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });
});
