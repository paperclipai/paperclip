import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentRunning = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentErroredFresh = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentErroredStale = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// The live-runs route only touches `db` and the authz helper; every other
// service import is stubbed so the route module loads without real wiring.
const mockAgentService = vi.hoisted(() => ({}));
const mockAccessService = vi.hoisted(() => ({}));
const mockApprovalService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({}));
const mockCompanySkillService = vi.hoisted(() => ({}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function runRow(overrides: Record<string, unknown>) {
  return {
    id: `run-${Math.random()}`,
    status: "running",
    invocationSource: "automation",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    agentId: agentRunning,
    agentName: "Agent",
    adapterType: "process",
    issueId: null,
    ...overrides,
  };
}

// Chainable stub whose terminal `.orderBy()`/`.limit()` resolve to `rows`.
function resolvingChain(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where"]) {
    builder[method] = () => builder;
  }
  builder.orderBy = () => Promise.resolve(rows);
  builder.limit = () => Promise.resolve(rows);
  return builder;
}

function createDbStub(opts: { liveRuns: unknown[]; latestPerAgent: unknown[] }) {
  return {
    select: vi.fn(() => resolvingChain(opts.liveRuns)),
    selectDistinctOn: vi.fn(() => resolvingChain(opts.latestPerAgent)),
  };
}

function createApp(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "operator", source: "local_implicit" };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/live-runs", () => {
  const liveRuns = [
    runRow({ agentId: agentRunning, status: "running" }),
    runRow({ agentId: agentRunning, status: "queued" }),
    runRow({ agentId: agentRunning, status: "queued" }),
  ];
  // Latest run per agent (what selectDistinctOn returns): a fresh failure, a
  // stale failure, and the running agent's latest (which supersedes failures).
  const latestPerAgent = [
    runRow({ agentId: agentRunning, status: "running", createdAt: new Date() }),
    runRow({
      agentId: agentErroredFresh,
      status: "failed",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    }),
    runRow({
      agentId: agentErroredStale,
      status: "timed_out",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    }),
  ];

  beforeEach(() => vi.clearAllMocks());

  it("returns only queued/running runs by default (no recent errors)", async () => {
    const db = createDbStub({ liveRuns, latestPerAgent });
    const res = await request(createApp(db)).get(`/api/companies/${companyId}/live-runs`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(db.selectDistinctOn).not.toHaveBeenCalled();
    expect(res.body.every((r: { status: string }) => ["queued", "running"].includes(r.status))).toBe(true);
  });

  it("appends only fresh failed latest-runs when includeRecentErrors=1", async () => {
    const db = createDbStub({ liveRuns, latestPerAgent });
    const res = await request(createApp(db)).get(
      `/api/companies/${companyId}/live-runs?includeRecentErrors=1`,
    );

    expect(res.status).toBe(200);
    expect(db.selectDistinctOn).toHaveBeenCalledTimes(1);
    // 3 live runs + the one fresh failure; the stale timeout and the
    // running-agent's latest are both excluded.
    expect(res.body).toHaveLength(4);
    const erroredIds = res.body
      .filter((r: { status: string }) => ["failed", "timed_out"].includes(r.status))
      .map((r: { agentId: string }) => r.agentId);
    expect(erroredIds).toEqual([agentErroredFresh]);
  });
});
