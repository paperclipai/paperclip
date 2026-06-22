import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = {
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  listAttachments: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
};

const mockHeartbeatService = {
  wakeup: vi.fn(async () => null),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
  reportRunActivity: vi.fn(async () => null),
};

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    decide: vi.fn(async () => ({ allowed: true })),
  })),
  agentService: vi.fn(() => ({ getById: vi.fn() })),
  clampIssueListLimit: vi.fn((value: number) => value),
  companySearchService: vi.fn(() => ({ search: vi.fn() })),
  companyService: vi.fn(() => ({ getById: vi.fn() })),
  documentAnnotationService: vi.fn(() => ({})),
  documentService: vi.fn(() => ({})),
  executionWorkspaceService: vi.fn(() => ({})),
  goalService: vi.fn(() => ({ getById: vi.fn() })),
  heartbeatService: vi.fn(() => mockHeartbeatService),
  issueApprovalService: vi.fn(() => ({ listApprovalsForIssue: vi.fn(), link: vi.fn(), unlink: vi.fn() })),
  issueRecoveryActionService: vi.fn(() => ({ getActiveForIssue: vi.fn(async () => null) })),
  issueReferenceService: vi.fn(() => ({
    syncIssue: vi.fn(async () => undefined),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [] })),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [] })),
  })),
  issueThreadInteractionService: vi.fn(() => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  })),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 100,
  logActivity: vi.fn(async () => undefined),
  projectService: vi.fn(() => ({ getById: vi.fn(async () => null) })),
  routineService: vi.fn(() => ({ syncRunStatusForIssue: vi.fn(async () => undefined) })),
  workProductService: vi.fn(() => ({})),
  issueService: () => mockIssueService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: vi.fn(() => ({})),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({})),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({})),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({})),
}));

vi.mock("../authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({
    actorType: "board",
    actorId: "board-user",
    agentId: null,
    runId: null,
    companyId: "company-1",
    companyIds: ["company-1"],
  })),
}));

vi.mock("../utils/watchdog-discovery.js", () => ({
  normalizeWatchdogDiscovery: vi.fn((v) => v),
  resolveTaskWatchdogProductBugFollowUp: vi.fn(async () => null),
}));

vi.mock("../utils/source-trust.js", () => ({
  sourceTrustForActorWrite: vi.fn(async () => null),
}));

vi.mock("../utils/cheap-recovery.js", () => ({
  assertCheapRecoveryIssueAssigneeProfileAllowed: vi.fn(async () => true),
}));

vi.mock("../utils/issue-assignment.js", () => ({
  normalizeIssueAssigneeAgentReference: vi.fn(async (cid: string, val: unknown) => val),
  resolveAssignmentProjectId: vi.fn(async (input: Record<string, unknown>) => (input as any).projectId),
}));

vi.mock("../utils/issue-execution-policy.js", () => ({
  normalizeIssueExecutionPolicy: vi.fn((p: unknown) => p),
  applyActorMonitorScheduledBy: vi.fn((p: unknown) => p),
}));

vi.mock("../utils/issue-environment-selection.js", () => ({
  assertIssueEnvironmentSelection: vi.fn(async () => undefined),
}));

vi.mock("../utils/issue-monitor.js", () => ({
  assertCanManageIssueMonitor: vi.fn(async () => undefined),
}));

vi.mock("../utils/issue-low-trust.js", () => ({
  assertLowTrustControlPlaneDenied: vi.fn(async () => false),
  assertTaskWatchdogCreateIssueAllowed: vi.fn(async () => true),
}));

vi.mock("../utils/issue-workspace-inheritance.js", () => ({
  resolveRunIssueWorkspaceInheritanceSource: vi.fn(async () => null),
  hasExplicitIssueWorkspaceCreateSelection: vi.fn(() => false),
}));

vi.mock("../utils/issue-read-allowed.js", () => ({
  assertIssueReadAllowed: vi.fn(async () => true),
}));

vi.mock("../utils/issue-task-watchdog.js", () => ({
  assertNoAgentHostWorkspaceCommandMutation: vi.fn(),
  collectIssueWorkspaceCommandPaths: vi.fn(() => []),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

import { issueRoutes } from "../routes/issues.js";

const mockLimit = vi.fn();
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: mockLimit })),
    })),
  })),
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { actor: Record<string, unknown> }, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, { deleteObject: vi.fn() } as never));
  return app;
}

const createdIssue = {
  id: "issue-created-1",
  companyId: "company-1",
  projectId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  status: "todo",
  identifier: "PAP-1",
  title: "Test issue",
  description: null,
  priority: "medium",
  workMode: "standard",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdByAgentId: null,
  createdByUserId: "board-user",
  relatedWork: { outbound: [] },
  referencedIssueIdentifiers: [],
};

describe("issueRoutes POST /companies/:companyId/issues idempotencyKey dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockLimit.mockResolvedValue([]);
  });

  it("creates a new issue when no idempotencyKey is provided", async () => {
    mockIssueService.getById.mockResolvedValue(createdIssue);
    mockIssueService.create.mockResolvedValue({
      ...createdIssue,
      id: "issue-new-1",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Test issue", status: "todo" });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Test issue");
  });

  it("returns existing issue when same idempotencyKey is sent twice", async () => {
    // First call: no existing issue found for idempotencyKey
    mockLimit.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(createdIssue);
    mockIssueService.create.mockResolvedValue({
      ...createdIssue,
      id: "issue-existing",
      identifier: "PAP-1",
    });

    // First request - creates the issue
    const res1 = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Test issue", status: "todo", idempotencyKey: "key-abc" });

    expect(res1.status).toBe(201);
    expect(res1.body.id).toBe("issue-existing");

    // Second call: existing issue found for idempotencyKey
    mockLimit.mockResolvedValue([{ id: "issue-existing" }]);
    mockIssueService.getById.mockResolvedValue({
      ...createdIssue,
      id: "issue-existing",
      identifier: "PAP-1",
    });

    // Second request with same key - should return existing
    const res2 = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Test issue", status: "todo", idempotencyKey: "key-abc" });

    expect(res2.status).toBe(200);
    expect(res2.body.id).toBe("issue-existing");
    expect(res2.body.identifier).toBe("PAP-1");
  });

  it("creates a different issue when a different idempotencyKey is provided", async () => {
    mockIssueService.getById.mockResolvedValue(createdIssue);
    mockIssueService.create.mockResolvedValue({
      ...createdIssue,
      id: "issue-new-2",
      identifier: "PAP-2",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Another issue", status: "todo", idempotencyKey: "key-def" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("issue-new-2");
    expect(res.body.identifier).toBe("PAP-2");
  });
});
