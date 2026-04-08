import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const runId = "run-11111111-1111-4111-8111-111111111111";
const queuedRunId = "run-22222222-2222-4222-8222-222222222222";
const issueId = "issue-33333333-3333-4333-8333-333333333333";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  getRun: vi.fn(),
  readLog: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function createApp() {
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
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: { issueId },
    createdAt: new Date("2026-04-05T06:40:00.000Z"),
    updatedAt: new Date("2026-04-05T06:40:00.000Z"),
    ...overrides,
  };
}

describe("heartbeat run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.list.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue(makeRun());
    mockHeartbeatService.readLog.mockResolvedValue({
      runId,
      store: "local_file",
      logRef: "logs/run.log",
      content: "hello\n",
      nextOffset: 6,
    });
  });

  it("adds derived issueId to company heartbeat run lists", async () => {
    mockHeartbeatService.list.mockResolvedValue([
      makeRun(),
      makeRun({
        id: queuedRunId,
        contextSnapshot: { issueId: "issue-44444444-4444-4444-8444-444444444444" },
      }),
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: runId, issueId }),
      expect.objectContaining({ id: queuedRunId, issueId: "issue-44444444-4444-4444-8444-444444444444" }),
    ]);
  });

  it("adds derived issueId to a single run response", async () => {
    const res = await request(createApp()).get(`/api/heartbeat-runs/${runId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: runId,
      issueId,
      contextSnapshot: expect.objectContaining({ issueId }),
    }));
  });

  it("returns an empty log payload for queued runs without a persisted log", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(makeRun({
      id: queuedRunId,
      status: "queued",
      logStore: null,
      logRef: null,
    }));

    const res = await request(createApp()).get(`/api/heartbeat-runs/${queuedRunId}/log`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      runId: queuedRunId,
      store: null,
      logRef: null,
      content: "",
    });
    expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
  });
});
