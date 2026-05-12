import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assigneeAgentId = "22222222-2222-4222-8222-222222222222";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
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

function makeIssue(input: {
  id: string;
  title: string;
  status?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    identifier: input.id === "child-1" ? "PAP-3701" : "PAP-3700",
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: "medium",
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

function expectClearAssignedStatusValidation(res: request.Response) {
  expect([400, 422]).toContain(res.status);
  expect(String(res.body?.error ?? res.text)).toMatch(/assign|assignee|status|backlog|todo/i);
}

describe("assigned backlog creation contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: "parent-1",
      title: "Parent issue",
      status: "blocked",
      assigneeAgentId,
    }));
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue({
        id: "issue-1",
        title: String(data.title),
        status: String(data.status),
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, data: Record<string, unknown>) => ({
      issue: makeIssue({
        id: "child-1",
        title: String(data.title),
        status: String(data.status),
        parentId: "parent-1",
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }),
      parentBlockerAdded: Boolean(data.blockParentUntilDone),
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("does not silently create a top-level assigned issue as backlog when status is omitted", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Assigned executable work",
        assigneeAgentId,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Assigned executable work",
        assigneeAgentId,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "todo",
    }));
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "create" }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: false,
        }),
      }),
    );
  });

  it("does not let a parent-blocking assigned child become an unwoken backlog leaf by default", async () => {
    const res = await request(await createApp())
      .post("/api/issues/parent-1/children")
      .send({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      parentId: "parent-1",
      status: "todo",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.child_created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: false,
          parentBlockerAdded: true,
        }),
      }),
    );
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "create" }),
      }),
    );
  });

  it("preserves deliberate assigned backlog as parked work without assignment wakeup", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "backlog",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        entityId: "issue-1",
        details: expect.objectContaining({
          status: "backlog",
          statusDefaulted: false,
          statusDefaultReason: "explicit",
          assignmentWakeSkipped: true,
          assignmentWakeSkipReason: "assigned_backlog",
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
