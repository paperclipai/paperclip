import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
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

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "00000000-0000-0000-0000-000000000001",
      companyId: "company-1",
      companyIds: ["company-1"],
      runId: "run-1",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const baseIssue = {
  id: "issue-target",
  companyId: "company-1",
  identifier: "PAP-200",
  title: "Target work",
  description: null,
  status: "todo" as const,
  priority: "medium" as const,
  parentId: null,
  projectId: null,
  assigneeAgentId: "00000000-0000-0000-0000-000000000001",
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

describe("issue checkout blocker gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.checkout.mockResolvedValue({ ...baseIssue, status: "in_progress" });
  });

  it("rejects checkout with 409 when an unresolved blocker exists", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "PAP-50",
          title: "Pre-req",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(await createApp())
      .post("/api/issues/issue-target/checkout")
      .send({ agentId: "00000000-0000-0000-0000-000000000001", expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("issue_blocked_by_unresolved_dependencies");
    expect(res.body.unresolvedBlockers).toHaveLength(1);
    expect(res.body.unresolvedBlockers[0].id).toBe("blocker-1");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.checkout_rejected_blocked" }),
    );
  });

  it("allows checkout when blockers exist but are all resolved", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "PAP-50",
          title: "Done blocker",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
        {
          id: "blocker-2",
          identifier: "PAP-51",
          title: "Cancelled blocker",
          status: "cancelled",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(await createApp())
      .post("/api/issues/issue-target/checkout")
      .send({ agentId: "00000000-0000-0000-0000-000000000001", expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      "issue-target",
      "00000000-0000-0000-0000-000000000001",
      ["todo"],
      "run-1",
    );
  });

  it("allows checkout when the issue has no blockers", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });

    const res = await request(await createApp())
      .post("/api/issues/issue-target/checkout")
      .send({ agentId: "00000000-0000-0000-0000-000000000001", expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });
});
