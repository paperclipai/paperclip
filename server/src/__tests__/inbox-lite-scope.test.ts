import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

// ---------- Mocked services ----------

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOUND_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "run-bound-1";

const mockHeartbeatGetRun = vi.hoisted(() => vi.fn());
const mockIssueList = vi.hoisted(() => vi.fn());
const mockIssueGetById = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: AGENT_ID,
      companyId: "company-1",
      name: "Test Agent",
      role: "engineer",
    })),
    list: vi.fn(async () => []),
  }),
  agentInstructionsService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  approvalService: () => ({}),
  budgetService: () => ({}),
  companySkillService: () => ({}),
  heartbeatService: () => ({
    getRun: mockHeartbeatGetRun,
    wakeup: vi.fn(async () => undefined),
    getActiveRunForAgent: vi.fn(async () => null),
  }),
  issueApprovalService: () => ({}),
  issueService: () => ({
    list: mockIssueList,
    getById: mockIssueGetById,
  }),
  logActivity: vi.fn(async () => undefined),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({ id: "settings-1", general: {} })),
    getExperimental: vi.fn(async () => ({})),
  }),
}));

vi.mock("../services/default-agent-instructions.js", () => ({
  getDefaultInstructionsPath: vi.fn(),
  getDefaultInstructionsTemplate: vi.fn(),
  resolveInstructionsFilePath: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(async () => []),
  detectAdapterModel: vi.fn(async () => null),
}));

vi.mock("../redaction.js", () => ({
  redactEventPayload: vi.fn((x: unknown) => x),
}));

vi.mock("../log-redaction.js", () => ({
  redactCurrentUserValue: vi.fn((x: unknown) => x),
}));

vi.mock("./org-chart-svg.js", () => ({
  renderOrgChartSvg: vi.fn(),
  renderOrgChartPng: vi.fn(),
  ORG_CHART_STYLES: [],
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@paperclipai/adapter-claude-local", () => ({
  DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS: true,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  readPaperclipSkillSyncPreference: vi.fn(),
  writePaperclipSkillSyncPreference: vi.fn(),
}));

// ---------- Helpers ----------

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: BOUND_ISSUE_ID,
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Bound issue",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ID,
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    activeRun: null,
    ...overrides,
  };
}

function createAgentApp(runId = RUN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------- Tests ----------

describe("inbox-lite task-bound scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: run resolves to bound issue
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { issueId: BOUND_ISSUE_ID },
    });
  });

  it("task-bound returns only bound issue", async () => {
    mockIssueGetById.mockResolvedValue(makeIssue());

    const res = await request(createAgentApp())
      .get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(BOUND_ISSUE_ID);
    expect(mockIssueList).not.toHaveBeenCalled();
  });

  it("task-bound with unknown runId → empty (fail-closed)", async () => {
    mockHeartbeatGetRun.mockResolvedValue(null);

    const res = await request(createAgentApp())
      .get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockIssueList).not.toHaveBeenCalled();
  });

  it("timer wake (no issueId) → full list", async () => {
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { source: "timer" },
    });
    mockIssueList.mockResolvedValue([
      makeIssue(),
      makeIssue({ id: OTHER_ISSUE_ID, identifier: "PAP-200" }),
    ]);

    const res = await request(createAgentApp())
      .get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockIssueList).toHaveBeenCalled();
  });

  it("bound issue not assigned to agent → empty", async () => {
    mockIssueGetById.mockResolvedValue(makeIssue({ assigneeAgentId: "other-agent" }));

    const res = await request(createAgentApp())
      .get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("global inbox includes in_review issues assigned to agent", async () => {
    // Timer wake → global list path (no issueId in contextSnapshot)
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { source: "timer" },
    });
    const inReviewIssue = makeIssue({ id: OTHER_ISSUE_ID, identifier: "PAP-300", status: "in_review" });
    mockIssueList.mockResolvedValue([inReviewIssue]);

    const res = await request(createAgentApp())
      .get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("in_review");

    // Verify the list query included in_review in the status filter
    expect(mockIssueList).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ status: expect.stringContaining("in_review") }),
    );
  });
});
