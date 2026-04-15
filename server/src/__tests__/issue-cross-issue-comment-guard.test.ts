import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_FOR_ISSUE_A = "aaaa0001-0001-4001-8001-aaaaaaaaaaaa";
const ISSUE_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type ActorOverrides = { runId?: string | null };

async function createApp(actorOverrides?: ActorOverrides) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId: actorOverrides?.runId !== undefined ? actorOverrides.runId : RUN_FOR_ISSUE_A,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_B_ID,
    companyId: "company-1",
    status: "done",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "some-user",
    identifier: "PAP-100",
    title: "Completed issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("cross-issue comment guard (OCT-552)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("rejects PATCH comment on done issue when agent run is for a different issue", async () => {
    const doneIssue = makeIssue({ id: ISSUE_B_ID, status: "done" });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_FOR_ISSUE_A,
      contextSnapshot: { issueId: ISSUE_A_ID },
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_B_ID}`)
      .send({ comment: "This comment is for the wrong issue" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/different issue/);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects POST comment on done issue when agent run is for a different issue", async () => {
    const doneIssue = makeIssue({ id: ISSUE_B_ID, status: "done" });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_FOR_ISSUE_A,
      contextSnapshot: { issueId: ISSUE_A_ID },
    });

    const res = await request(await createApp())
      .post(`/api/issues/${ISSUE_B_ID}/comments`)
      .send({ body: "This comment is for the wrong issue" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/different issue/);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows agent to comment on done issue when run context matches", async () => {
    const doneIssue = makeIssue({ id: ISSUE_B_ID, status: "done" });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockIssueService.update.mockResolvedValue(doneIssue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_B_ID,
      companyId: "company-1",
      body: "Correct run context",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_FOR_ISSUE_A,
      contextSnapshot: { issueId: ISSUE_B_ID },
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_B_ID}`)
      .send({ comment: "Correct run context" });

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("allows agent to comment on done issue when no run ID is provided", async () => {
    const doneIssue = makeIssue({ id: ISSUE_B_ID, status: "done" });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockIssueService.update.mockResolvedValue(doneIssue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_B_ID,
      companyId: "company-1",
      body: "No run ID",
    });

    const res = await request(await createApp({ runId: null }))
      .patch(`/api/issues/${ISSUE_B_ID}`)
      .send({ comment: "No run ID" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("allows agent to comment on in_progress issue even if run is for a different issue", async () => {
    const activeIssue = makeIssue({
      id: ISSUE_B_ID,
      status: "in_progress",
      assigneeAgentId: "other-agent",
    });
    mockIssueService.getById.mockResolvedValue(activeIssue);
    mockIssueService.update.mockResolvedValue(activeIssue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_B_ID,
      companyId: "company-1",
      body: "Cross-issue on active issue",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_B_ID}`)
      .send({ comment: "Cross-issue on active issue" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
  });

  it("rejects POST comment on cancelled issue when run is for different issue", async () => {
    const cancelledIssue = makeIssue({ id: ISSUE_B_ID, status: "cancelled" });
    mockIssueService.getById.mockResolvedValue(cancelledIssue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_FOR_ISSUE_A,
      contextSnapshot: { issueId: ISSUE_A_ID },
    });

    const res = await request(await createApp())
      .post(`/api/issues/${ISSUE_B_ID}/comments`)
      .send({ body: "Wrong issue" });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects comment on done issue when run record is not found", async () => {
    const doneIssue = makeIssue({ id: ISSUE_B_ID, status: "done" });
    mockIssueService.getById.mockResolvedValue(doneIssue);
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_B_ID}`)
      .send({ comment: "Stale run ID" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/run not found/i);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
