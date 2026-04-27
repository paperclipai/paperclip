import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTreeControlService = vi.hoisted(() => ({
  preview: vi.fn(),
  createHold: vi.fn(),
  cancelIssueStatusesForHold: vi.fn(),
  restoreIssueStatusesForHold: vi.fn(),
  getHold: vi.fn(),
  releaseHold: vi.fn(),
  cancelUnclaimedWakeupsForTree: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  wakeup: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  issueTreeControlService: () => mockTreeControlService,
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
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-2",
    });
    mockTreeControlService.cancelUnclaimedWakeupsForTree.mockResolvedValue([]);
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
    });
    mockTreeControlService.cancelIssueStatusesForHold.mockResolvedValue({
      updatedIssueIds: [
        "11111111-1111-4111-8111-111111111111",
        "55555555-5555-4555-8555-555555555555",
      ],
      updatedIssues: [],
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "cancel", reason: "cancel subtree" });

    expect(res.status).toBe(201);
    expect(mockTreeControlService.cancelIssueStatusesForHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    );
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
    });
    mockTreeControlService.cancelIssueStatusesForHold.mockResolvedValue({
      updatedIssueIds: ["11111111-1111-4111-8111-111111111111"],
      updatedIssues: [],
    });
    mockHeartbeatService.cancelRun.mockRejectedValue(new Error("adapter process did not exit"));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "cancel", reason: "cancel subtree" });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(mockTreeControlService.cancelIssueStatusesForHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    );
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
    });
    mockTreeControlService.restoreIssueStatusesForHold.mockResolvedValue({
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
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree", metadata: { wakeAgents: true } });

    expect(res.status).toBe(200);
    expect(mockTreeControlService.restoreIssueStatusesForHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "66666666-6666-4666-8666-666666666666",
      expect.objectContaining({ reason: "restore subtree" }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_tree_restored",
        payload: expect.objectContaining({ issueId: "55555555-5555-4555-8555-555555555555" }),
      }),
    );
    expect(res.body.hold.status).toBe("released");
  });

  it("releases a restore hold if the restore application fails", async () => {
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
    });
    mockTreeControlService.restoreIssueStatusesForHold.mockRejectedValue(new Error("restore failed"));
    mockTreeControlService.releaseHold.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      mode: "restore",
      status: "released",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree" });

    expect(res.status).toBe(500);
    expect(mockTreeControlService.releaseHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "66666666-6666-4666-8666-666666666666",
      expect.objectContaining({
        reason: "Restore operation failed before subtree status updates completed",
        metadata: { cleanup: "restore_failed_before_apply" },
      }),
    );
  });
});
