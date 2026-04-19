import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  readLog: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentInstructionsService: () => ({}),
  agentService: () => ({ getChainOfCommand: vi.fn(async () => []), getById: vi.fn(async () => null) }),
  approvalService: () => ({}),
  budgetService: () => ({}),
  companySkillService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(async () => undefined),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

function createLiveRunsDbStub(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, innerJoin, where, orderBy };
}

async function createApp(actor: Record<string, unknown>, rows: unknown[] = []) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const db = createLiveRunsDbStub(rows);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as never));
  app.use(errorHandler);
  return { app, db };
}

describe("live runs route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("allows same-company agents to list live runs", async () => {
    const rows = [{
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "system",
      startedAt: "2026-04-15T12:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-15T12:00:00.000Z",
      agentId: "agent-1",
      agentName: "OpenClawOps",
      adapterType: "openclaw_gateway",
      issueId: "issue-1",
    }];
    const { app, db } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }, rows);

    const res = await request(app).get("/api/companies/company-1/live-runs");

    expect(res.status).toBe(200);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(rows);
  });

  it("rejects agents that target another company", async () => {
    const { app, db } = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-2/live-runs");

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
