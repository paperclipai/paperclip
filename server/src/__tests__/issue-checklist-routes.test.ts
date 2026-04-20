import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  listChecklistItems: vi.fn(),
  getChecklistItemById: vi.fn(),
  createChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
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
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.js")>("../routes/authz.js"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.js")>("../middleware/validate.js"),
  );
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  vi.resetModules();
  registerModuleMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "PAP-901",
    title: "Checklist route issue",
    executionWorkspaceId: null,
    ...overrides,
  };
}

function makeChecklistItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    title: "Wire the checklist",
    position: 0,
    completedAt: null,
    completedByAgentId: null,
    completedByUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdByRunId: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("issue checklist routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listChecklistItems.mockResolvedValue([makeChecklistItem()]);
    mockIssueService.getChecklistItemById.mockResolvedValue(makeChecklistItem());
    mockIssueService.createChecklistItem.mockImplementation(async (_issue, data) => makeChecklistItem({ title: data.title }));
    mockIssueService.updateChecklistItem.mockImplementation(async (_id, data) =>
      makeChecklistItem({
        title: data.title ?? "Wire the checklist",
        completedAt: data.completed ? new Date("2026-04-06T13:00:00.000Z") : null,
        completedByUserId: data.completed ? "local-board" : null,
      }),
    );
    mockIssueService.deleteChecklistItem.mockResolvedValue(makeChecklistItem());
  });

  it("lists checklist items for an accessible issue", async () => {
    const res = await request(await createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/checklist-items",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        title: "Wire the checklist",
      }),
    ]);
  });

  it("rejects cross-company agent access", async () => {
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-2",
    })).get("/api/issues/11111111-1111-4111-8111-111111111111/checklist-items");

    expect(res.status).toBe(403);
  });

  it("creates checklist items and logs activity", async () => {
    const res = await request(await createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checklist-items")
      .send({ title: "Write UI tests" });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChecklistItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      { title: "Write UI tests" },
      { agentId: null, userId: "local-board", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.checklist_item_created",
        details: expect.objectContaining({ title: "Write UI tests" }),
      }),
    );
  });

  it("uses checkout ownership for assigned in-progress agent mutations", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: "agent-1",
    }));
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "33333333-3333-4333-8333-333333333333",
      runStatus: "running",
    }))
      .patch("/api/issue-checklist-items/22222222-2222-4222-8222-222222222222")
      .send({ completed: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "agent-1",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(mockIssueService.updateChecklistItem).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { completed: true },
      { agentId: "agent-1", userId: null, runId: "33333333-3333-4333-8333-333333333333" },
    );
  });

  it("deletes checklist items and logs activity", async () => {
    const res = await request(await createApp())
      .delete("/api/issue-checklist-items/22222222-2222-4222-8222-222222222222");

    expect(res.status).toBe(200);
    expect(mockIssueService.deleteChecklistItem).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.checklist_item_deleted",
        details: expect.objectContaining({ title: "Wire the checklist" }),
      }),
    );
  });
});
