import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";

const {
  getByIdMock,
  wakeupMock,
  logActivityMock,
  insertValuesMock,
} = vi.hoisted(() => ({
  getByIdMock: vi.fn(),
  wakeupMock: vi.fn(),
  logActivityMock: vi.fn(),
  insertValuesMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: vi.fn(() => ({
    getById: getByIdMock,
    list: vi.fn(),
    update: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    remove: vi.fn(),
    createKey: vi.fn(),
    listKeys: vi.fn(),
    revokeKey: vi.fn(),
    updatePermissions: vi.fn(),
  })),
  accessService: vi.fn(() => ({})),
  approvalService: vi.fn(() => ({})),
  budgetService: vi.fn(() => ({})),
  heartbeatService: vi.fn(() => ({
    wakeup: wakeupMock,
  })),
  issueApprovalService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({})),
  logActivity: logActivityMock,
  secretService: vi.fn(() => ({})),
  workspaceOperationService: vi.fn(() => ({})),
}));

function createApp() {
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertValuesMock(values);
        return {
          onConflictDoNothing: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      runId: "run-123",
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  return app;
}

describe("POST /api/agents/:id/wakeup run FK stub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Gateway Agent",
      adapterType: "openclaw_gateway",
    });
    wakeupMock.mockResolvedValue({ id: "heartbeat-run-1", status: "queued" });
    logActivityMock.mockResolvedValue(undefined);
  });

  it("upserts a heartbeat run stub when actor runId is provided", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const res = await request(createApp())
      .post(`/api/agents/${agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", forceFreshSession: false });

    expect(res.status).toBe(202);
    expect(insertValuesMock).toHaveBeenCalledWith({
      id: "run-123",
      companyId: "company-1",
      agentId,
      invocationSource: "on_demand",
      status: "running",
    });
  });
});
