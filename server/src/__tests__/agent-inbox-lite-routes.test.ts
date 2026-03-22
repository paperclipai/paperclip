import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  approvalService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  secretService: () => ({}),
  workspaceOperationService: () => ({}),
}));

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      runId: "33333333-3333-4333-8333-333333333333",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent inbox-lite route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes explicit assignee fields for assigned inbox items", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        identifier: "NOV-11",
        title: "Assigned work",
        status: "in_progress",
        priority: "high",
        projectId: "55555555-5555-4555-8555-555555555555",
        goalId: "66666666-6666-4666-8666-666666666666",
        parentId: "77777777-7777-4777-8777-777777777777",
        assigneeAgentId: AGENT_ID,
        assigneeUserId: null,
        updatedAt: new Date("2026-03-21T03:05:25.000Z"),
        activeRun: null,
      },
    ]);

    const res = await request(createAgentApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(COMPANY_ID, {
      assigneeAgentId: AGENT_ID,
      status: "todo,in_progress,blocked",
    });
    expect(res.body).toEqual([
      expect.objectContaining({
        identifier: "NOV-11",
        assigneeAgentId: AGENT_ID,
        assigneeUserId: null,
      }),
    ]);
  });
});
