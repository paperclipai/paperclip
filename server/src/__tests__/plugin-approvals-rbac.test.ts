import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before any imports that pull in the services
// ---------------------------------------------------------------------------

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  listByPlugin: vi.fn(),
  cancel: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

// ---------------------------------------------------------------------------
// App factories for each actor type
// ---------------------------------------------------------------------------

type ActorType = "board" | "agent" | "none";

async function createApp(
  actorType: ActorType,
  companyIds = ["company-1"],
  pluginWorkerManager?: { getWorker: (id: string) => { notify: ReturnType<typeof vi.fn> } | null },
) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actorType === "board") {
      (req as any).actor = {
        type: "board",
        userId: "user-board",
        companyIds,
        source: "session",
        isInstanceAdmin: false,
      };
    } else if (actorType === "agent") {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "api_key",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = { type: "none" };
    }
    next();
  });
  app.use("/api", approvalRoutes({} as any, pluginWorkerManager ? { pluginWorkerManager } as any : {}));
  app.use(errorHandler);
  return app;
}

// Approval fixture for a plugin_workflow approval
const pluginApproval = {
  id: "approval-pw-1",
  companyId: "company-1",
  type: "plugin_workflow",
  status: "pending",
  payload: { prompt: "Approve deployment?" },
  requestedByAgentId: null,
  requestedByUserId: null,
  decidedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  sourcePluginId: "plugin-1",
  sourcePluginKey: "my-plugin",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

describe("WF-1 RBAC: approve / reject require board actor", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(pluginApproval);
  });

  // -------------------------------------------------------------------------
  // approve endpoint
  // -------------------------------------------------------------------------

  it("approve: board actor succeeds (applies resolution)", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pluginApproval, status: "approved", decidedByUserId: "user-board" },
      applied: true,
    });

    const res = await request(await createApp("board"))
      .post("/api/approvals/approval-pw-1/approve")
      .send({ decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-pw-1", "user-board", "ship it");
  });

  it("approve: agent actor is forbidden (403)", async () => {
    const res = await request(await createApp("agent"))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("approve: unauthenticated actor is forbidden (401 or 403)", async () => {
    const res = await request(await createApp("none"))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect([401, 403]).toContain(res.status);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // reject endpoint
  // -------------------------------------------------------------------------

  it("reject: board actor succeeds", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...pluginApproval, status: "rejected", decidedByUserId: "user-board" },
      applied: true,
    });

    const res = await request(await createApp("board"))
      .post("/api/approvals/approval-pw-1/reject")
      .send({ decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-pw-1", "user-board", "not now");
  });

  it("reject: agent actor is forbidden (403)", async () => {
    const res = await request(await createApp("agent"))
      .post("/api/approvals/approval-pw-1/reject")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  it("reject: unauthenticated actor is forbidden (401 or 403)", async () => {
    const res = await request(await createApp("none"))
      .post("/api/approvals/approval-pw-1/reject")
      .send({});

    expect([401, 403]).toContain(res.status);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // board actor from a different company is blocked
  // -------------------------------------------------------------------------

  it("approve: board actor from different company is forbidden (403 or 404)", async () => {
    // approval belongs to company-1; board has access to company-2 only
    const res = await request(await createApp("board", ["company-2"]))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect([403, 404]).toContain(res.status);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Plugin worker cannot approve/reject even with all plugin capabilities
  // (plugin workers are surfaced as "agent" type at the HTTP layer — no
  //  special "plugin_worker" actor type exists; the SDK host services bypass
  //  the HTTP route entirely for plugin-initiated operations)
  // -------------------------------------------------------------------------

  it("approve: plugin worker identity (agent actor) is forbidden (403)", async () => {
    // Even if a hypothetical plugin worker had all plugin capabilities, it
    // cannot call the approve route because assertBoard rejects any non-board actor.
    const res = await request(await createApp("agent"))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("reject: plugin worker identity (agent actor) is forbidden (403)", async () => {
    const res = await request(await createApp("agent"))
      .post("/api/approvals/approval-pw-1/reject")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Plugin worker notification on approve/reject (fire-and-forget)
  // -------------------------------------------------------------------------

  it("approve: notifies the plugin worker when sourcePluginId is set and worker exists", async () => {
    const notifyMock = vi.fn();
    const mockWorker = { notify: notifyMock };
    const mockWorkerManager = {
      getWorker: vi.fn(() => mockWorker),
    };

    mockApprovalService.approve.mockResolvedValue({
      approval: {
        ...pluginApproval,
        status: "approved",
        decidedByUserId: "user-board",
        decidedAt: new Date("2026-05-01T12:00:00.000Z"),
        decisionNote: "approved",
      },
      applied: true,
    });

    const res = await request(await createApp("board", ["company-1"], mockWorkerManager as any))
      .post("/api/approvals/approval-pw-1/approve")
      .send({ decisionNote: "approved" });

    expect(res.status).toBe(200);
    expect(mockWorkerManager.getWorker).toHaveBeenCalledWith("plugin-1");
    expect(notifyMock).toHaveBeenCalledWith(
      "approvals.resolved",
      expect.objectContaining({ approvalId: "approval-pw-1", status: "approved" }),
    );
  });

  it("reject: notifies the plugin worker when sourcePluginId is set and worker exists", async () => {
    const notifyMock = vi.fn();
    const mockWorker = { notify: notifyMock };
    const mockWorkerManager = {
      getWorker: vi.fn(() => mockWorker),
    };

    mockApprovalService.reject.mockResolvedValue({
      approval: {
        ...pluginApproval,
        status: "rejected",
        decidedByUserId: "user-board",
        decidedAt: new Date("2026-05-01T12:00:00.000Z"),
        decisionNote: "not now",
      },
      applied: true,
    });

    const res = await request(await createApp("board", ["company-1"], mockWorkerManager as any))
      .post("/api/approvals/approval-pw-1/reject")
      .send({ decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockWorkerManager.getWorker).toHaveBeenCalledWith("plugin-1");
    expect(notifyMock).toHaveBeenCalledWith(
      "approvals.resolved",
      expect.objectContaining({ approvalId: "approval-pw-1", status: "rejected" }),
    );
  });

  it("approve: continues when plugin worker notification throws", async () => {
    const notifyMock = vi.fn(() => {
      throw new Error("worker gone");
    });
    const mockWorker = { notify: notifyMock };
    const mockWorkerManager = {
      getWorker: vi.fn(() => mockWorker),
    };

    mockApprovalService.approve.mockResolvedValue({
      approval: {
        ...pluginApproval,
        status: "approved",
        decidedByUserId: "user-board",
        decidedAt: new Date("2026-05-01T12:00:00.000Z"),
      },
      applied: true,
    });

    const res = await request(await createApp("board", ["company-1"], mockWorkerManager as any))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(notifyMock).toHaveBeenCalledWith(
      "approvals.resolved",
      expect.objectContaining({ approvalId: "approval-pw-1", status: "approved" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.approved" }),
    );
  });

  it("approve: skips notification when worker is not running", async () => {
    const mockWorkerManager = { getWorker: vi.fn(() => null) };

    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pluginApproval, status: "approved", decidedByUserId: "user-board" },
      applied: true,
    });

    const res = await request(await createApp("board", ["company-1"], mockWorkerManager as any))
      .post("/api/approvals/approval-pw-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockWorkerManager.getWorker).toHaveBeenCalledWith("plugin-1");
  });
});
