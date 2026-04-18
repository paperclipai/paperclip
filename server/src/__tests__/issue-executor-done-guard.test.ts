import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Executor Done Guard (Kuromi DGG-2611 / 2026-04-19)
// Ensures that agent executors cannot self-transition in_review -> done.
// Only board users or governance-role agents (role ceo/coo or canCreateAgents
// permission) may close an issue. routine_execution origin stays self-close.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => mockAgentService,
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

type ActorOverride = {
  type: "board" | "agent";
  agentId?: string;
  companyId?: string;
};

async function createApp(actor: ActorOverride) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "board") {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = {
        type: "agent",
        agentId: actor.agentId,
        companyId: actor.companyId ?? "company-1",
        source: "agent_token",
      };
    }
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function buildIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "DGG-9999",
    title: "Executor done guard fixture",
    originKind: "manual",
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

describe("executor done-transition guard (DGG-2611)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_EXECUTOR_DONE_GUARD;
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...buildIssue(),
      ...patch,
      updatedAt: new Date(),
    }));
  });

  it("rejects executor (engineer role) self-transition to done with 400 + executor_done_forbidden reason", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue());
    mockAgentService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      role: "engineer",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "22222222-2222-4222-8222-222222222222" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("executor_done_forbidden");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows governance-role agent (coo) to transition in_review -> done", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue());
    mockAgentService.getById.mockResolvedValue({
      id: "coo-agent-id-0000000000000000000000",
      companyId: "company-1",
      role: "coo",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "coo-agent-id-0000000000000000000000" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows ceo role done transition", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue());
    mockAgentService.getById.mockResolvedValue({
      id: "ceo-agent-id-0000000000000000000000",
      companyId: "company-1",
      role: "ceo",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "ceo-agent-id-0000000000000000000000" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("allows engineer role self-close when origin is routine_execution", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue({ originKind: "routine_execution" }));
    mockAgentService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      role: "engineer",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "22222222-2222-4222-8222-222222222222" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("allows board users to transition done unconditionally", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue());

    const res = await request(await createApp({ type: "board" }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("is disabled by PAPERCLIP_EXECUTOR_DONE_GUARD=off env toggle", async () => {
    process.env.PAPERCLIP_EXECUTOR_DONE_GUARD = "off";
    mockIssueService.getById.mockResolvedValue(buildIssue());
    mockAgentService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      role: "engineer",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "22222222-2222-4222-8222-222222222222" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("does not trigger on non-done status transitions", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue());
    mockAgentService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      role: "engineer",
      permissions: null,
    });

    const res = await request(
      await createApp({ type: "agent", agentId: "22222222-2222-4222-8222-222222222222" }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
  });
});
