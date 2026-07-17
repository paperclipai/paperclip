import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTreeControlService = vi.hoisted(() => ({
  listTreeIssues: vi.fn(),
  preview: vi.fn(),
  createHold: vi.fn(),
  cancelIssueStatusesForHold: vi.fn(),
  restoreIssueStatusesForHold: vi.fn(),
  getHold: vi.fn(),
  listHolds: vi.fn(),
  getActivePauseHoldGate: vi.fn(),
  releaseHold: vi.fn(),
  cancelUnclaimedWakeupsForTree: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  canUserAccessProject: vi.fn(),
  hasPermission: vi.fn(),
  isCompanyOwner: vi.fn(),
  hasProjectPermission: vi.fn(),
}));
const mockIssueVisibilityService = vi.hoisted(() => ({ filterVisibleIssues: vi.fn() }));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  wakeup: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  issueTreeControlService: () => mockTreeControlService,
  issueVisibilityService: () => mockIssueVisibilityService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueTreeControlRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issue-tree-control.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueTreeControlRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issue tree control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const rootIssue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-2",
      projectId: null,
      visibility: "company",
      createdByUserId: null,
      createdByAgentId: null,
      assigneeUserId: null,
      assigneeAgentId: null,
    };
    mockIssueService.getById.mockResolvedValue(rootIssue);
    mockTreeControlService.listTreeIssues.mockResolvedValue([rootIssue]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.canUserAccessProject.mockResolvedValue(true);
    mockAccessService.isCompanyOwner.mockResolvedValue(false);
    mockAccessService.hasProjectPermission.mockResolvedValue(true);
    mockIssueVisibilityService.filterVisibleIssues.mockImplementation(async (_principal, tree) => tree);
    mockTreeControlService.cancelUnclaimedWakeupsForTree.mockResolvedValue([]);
    mockTreeControlService.listHolds.mockResolvedValue([]);
    mockTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockTreeControlService.cancelIssueStatusesForHold.mockResolvedValue({ updatedIssueIds: [], updatedIssues: [] });
    mockTreeControlService.restoreIssueStatusesForHold.mockResolvedValue({
      updatedIssueIds: [],
      updatedIssues: [],
      releasedCancelHoldIds: [],
      restoreHold: null,
    });
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
  });

  it("rejects cross-company preview requests before calling the preview service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-control/preview")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockTreeControlService.preview).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("requires board access for hold creation", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-2",
      runId: null,
      source: "api_key",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockTreeControlService.createHold).not.toHaveBeenCalled();
  });

  it("rejects the unimplemented automatic release strategy", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause", releasePolicy: { strategy: "after_active_runs_finish" } });

    expect(res.status).toBe(400);
    expect(mockTreeControlService.createHold).not.toHaveBeenCalled();
  });

  it("rejects a tree preview when any descendant project is inaccessible", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.listTreeIssues.mockResolvedValue([
      { ...(await mockIssueService.getById()), projectId: null },
      {
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "company-2",
        projectId: "33333333-3333-4333-8333-333333333333",
        visibility: "company",
        createdByUserId: null,
        createdByAgentId: null,
        assigneeUserId: null,
        assigneeAgentId: null,
      },
    ]);
    mockAccessService.canUserAccessProject.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-control/preview")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockTreeControlService.preview).not.toHaveBeenCalled();
  });

  it("conceals a tree when any private descendant is not visible", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    const root = await mockIssueService.getById();
    mockTreeControlService.listTreeIssues.mockResolvedValue([
      root,
      {
        ...root,
        id: "22222222-2222-4222-8222-222222222222",
        visibility: "private",
      },
    ]);
    mockIssueVisibilityService.filterVisibleIssues.mockResolvedValue([root]);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-control/preview")
      .send({ mode: "pause" });

    expect(res.status).toBe(404);
    expect(mockTreeControlService.preview).not.toHaveBeenCalled();
  });

  it("requires issues:manage or project edit for every mutation scope", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockTreeControlService.createHold).not.toHaveBeenCalled();
  });

  it("does not disclose historical hold members that are outside private visibility", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    const root = await mockIssueService.getById();
    const hiddenMember = {
      ...root,
      id: "22222222-2222-4222-8222-222222222222",
      visibility: "private",
    };
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === hiddenMember.id ? hiddenMember : root);
    mockTreeControlService.listHolds.mockResolvedValue([
      { id: "hold-1", rootIssueId: root.id, members: [{ issueId: hiddenMember.id }] },
    ]);
    mockIssueVisibilityService.filterVisibleIssues.mockImplementation(async (_principal, rows) =>
      rows.some((issue: { id: string }) => issue.id === hiddenMember.id) ? [] : rows);

    const res = await request(app)
      .get("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds?includeMembers=true");

    expect(res.status).toBe(404);
  });

  it("cancels active descendant runs when creating a pause hold", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "33333333-3333-4333-8333-333333333333",
        mode: "pause",
        reason: "pause subtree",
      },
      preview: {
        mode: "pause",
        totals: { affectedIssues: 1 },
        warnings: [],
        activeRuns: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            issueId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause", reason: "pause subtree" });

    expect(res.status).toBe(201);
    expect(mockTreeControlService.createHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        expectedIssueIds: ["11111111-1111-4111-8111-111111111111"],
        authorizeLockedBoundary: expect.any(Function),
      }),
    );
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(mockTreeControlService.cancelUnclaimedWakeupsForTree).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "Cancelled because an active subtree pause hold was created",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.tree_hold_run_interrupted",
        entityId: "44444444-4444-4444-8444-444444444444",
      }),
    );
  });

  it("marks affected issues cancelled when creating a cancel hold", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "33333333-3333-4333-8333-333333333333",
        mode: "cancel",
        reason: "cancel subtree",
      },
      preview: {
        mode: "cancel",
        totals: { affectedIssues: 2 },
        warnings: [],
        activeRuns: [],
      },
      statusUpdate: {
        updatedIssueIds: [
          "11111111-1111-4111-8111-111111111111",
          "55555555-5555-4555-8555-555555555555",
        ],
        updatedIssues: [],
      },
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "cancel", reason: "cancel subtree" });

    expect(res.status).toBe(201);
    expect(mockTreeControlService.cancelIssueStatusesForHold).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.tree_cancel_status_updated",
        details: expect.objectContaining({ cancelledIssueCount: 2 }),
      }),
    );
  });

  it("still marks affected issues cancelled when run interruption fails", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "33333333-3333-4333-8333-333333333333",
        mode: "cancel",
        reason: "cancel subtree",
      },
      preview: {
        mode: "cancel",
        totals: { affectedIssues: 1 },
        warnings: [],
        activeRuns: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            issueId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
      statusUpdate: {
        updatedIssueIds: ["11111111-1111-4111-8111-111111111111"],
        updatedIssues: [],
      },
    });
    mockHeartbeatService.cancelRun.mockRejectedValue(new Error("adapter process did not exit"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "cancel", reason: "cancel subtree" });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(mockTreeControlService.cancelIssueStatusesForHold).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.tree_hold_run_interrupt_failed",
        entityId: "44444444-4444-4444-8444-444444444444",
        details: expect.objectContaining({
          error: "adapter process did not exit",
        }),
      }),
    );
  });

  it("restores affected issues and can request explicit wakeups", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "66666666-6666-4666-8666-666666666666",
        mode: "restore",
        reason: "restore subtree",
      },
      preview: {
        mode: "restore",
        totals: { affectedIssues: 1 },
        warnings: [],
        activeRuns: [],
      },
      statusUpdate: {
        updatedIssueIds: ["55555555-5555-4555-8555-555555555555"],
        updatedIssues: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            status: "todo",
            assigneeAgentId: "22222222-2222-4222-8222-222222222222",
          },
        ],
        releasedCancelHoldIds: ["33333333-3333-4333-8333-333333333333"],
        restoreHold: {
          id: "66666666-6666-4666-8666-666666666666",
          mode: "restore",
          status: "released",
        },
      },
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree", metadata: { wakeAgents: true } });

    expect(res.status).toBe(200);
    expect(mockTreeControlService.restoreIssueStatusesForHold).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_tree_restored",
        payload: expect.objectContaining({ issueId: "55555555-5555-4555-8555-555555555555" }),
      }),
    );
    expect(res.body.hold.status).toBe("released");
  });

  it("does not leave a cleanup hold when atomic restore creation fails", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockRejectedValue(new Error("restore failed"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree" });

    expect(res.status).toBe(500);
    expect(mockTreeControlService.releaseHold).not.toHaveBeenCalled();
  });

  it("returns resume operations as released holds and avoids cancellation side effects", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "77777777-7777-4777-8777-777777777777",
        mode: "resume",
        status: "released",
        reason: "resume subtree",
      },
      preview: {
        mode: "resume",
        totals: {
          affectedIssues: 1,
        },
        warnings: [],
        activeRuns: [],
      },
      resumedPauseHoldIds: ["33333333-3333-4333-8333-333333333333"],
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "resume", reason: "resume subtree" });

    expect(res.status).toBe(200);
    expect(res.body.hold.mode).toBe("resume");
    expect(res.body.hold.status).toBe("released");
    expect(res.body.resumedPauseHoldIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockTreeControlService.cancelUnclaimedWakeupsForTree).not.toHaveBeenCalled();
    expect(mockTreeControlService.cancelIssueStatusesForHold).not.toHaveBeenCalled();
    expect(mockTreeControlService.restoreIssueStatusesForHold).not.toHaveBeenCalled();
  });
});
