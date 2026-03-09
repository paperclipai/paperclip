import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockRun = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "failed",
  dismissedAt: null,
};

const mockDismissedRun = {
  ...mockRun,
  dismissedAt: new Date("2026-03-08T00:00:00Z"),
};

const mockHeartbeat = vi.hoisted(() => ({
  getRun: vi.fn(),
  dismissRun: vi.fn(),
  listEvents: vi.fn(),
  cancelRun: vi.fn(),
  startRun: vi.fn(),
  getRunLogChunk: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  heartbeatService: () => mockHeartbeat,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  secretService: () => ({}),
  logActivity: mockLogActivity,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

vi.mock("../redaction.js", () => ({
  redactEventPayload: vi.fn((p: unknown) => p),
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@paperclipai/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "codex-mini",
}));

vi.mock("@paperclipai/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "cursor-small",
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

describe("POST /heartbeat-runs/:runId/dismiss", () => {
  beforeEach(() => {
    mockHeartbeat.getRun.mockReset();
    mockHeartbeat.dismissRun.mockReset();
    mockLogActivity.mockReset();
  });

  it("rejects non-board actors with 403", async () => {
    const app = createApp(agentActor);
    const res = await request(app).post("/heartbeat-runs/run-1/dismiss").send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockHeartbeat.getRun).not.toHaveBeenCalled();
  });

  it("returns 404 when run does not exist", async () => {
    mockHeartbeat.getRun.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app).post("/heartbeat-runs/run-1/dismiss").send({});
    expect(res.status).toBe(404);
    expect(mockHeartbeat.dismissRun).not.toHaveBeenCalled();
  });

  it("rejects cross-company access with 403", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ ...mockRun, companyId: "company-other" });
    const app = createApp(boardActor);
    const res = await request(app).post("/heartbeat-runs/run-1/dismiss").send({});
    expect(res.status).toBe(403);
    expect(mockHeartbeat.dismissRun).not.toHaveBeenCalled();
  });

  it("dismisses run for authorized board user", async () => {
    mockHeartbeat.getRun.mockResolvedValue(mockRun);
    mockHeartbeat.dismissRun.mockResolvedValue(mockDismissedRun);
    mockLogActivity.mockResolvedValue(undefined);
    const app = createApp(boardActor);

    const res = await request(app).post("/heartbeat-runs/run-1/dismiss").send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("run-1");
    expect(res.body.dismissedAt).toBeTruthy();
    expect(mockHeartbeat.dismissRun).toHaveBeenCalledWith("run-1");
  });

  it("is idempotent for already-dismissed runs", async () => {
    mockHeartbeat.getRun.mockResolvedValue(mockDismissedRun);
    mockHeartbeat.dismissRun.mockResolvedValue(mockDismissedRun);
    mockLogActivity.mockResolvedValue(undefined);
    const app = createApp(boardActor);

    const res = await request(app).post("/heartbeat-runs/run-1/dismiss").send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs activity on successful dismiss", async () => {
    mockHeartbeat.getRun.mockResolvedValue(mockRun);
    mockHeartbeat.dismissRun.mockResolvedValue(mockDismissedRun);
    mockLogActivity.mockResolvedValue(undefined);
    const app = createApp(boardActor);

    await request(app).post("/heartbeat-runs/run-1/dismiss").send({});

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "heartbeat.dismissed",
        entityType: "heartbeat_run",
        entityId: "run-1",
      }),
    );
  });
});
