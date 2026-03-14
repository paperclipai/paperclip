import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockKnowledgeService = vi.hoisted(() => ({
  listRelevantForIssueContext: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  goalService: () => mockGoalService,
  heartbeatService: () => ({ requestWakeup: vi.fn() }),
  issueApprovalService: () => ({ listForIssue: vi.fn() }),
  issueService: () => mockIssueService,
  knowledgeService: () => mockKnowledgeService,
  logActivity: vi.fn(),
  projectService: () => mockProjectService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue heartbeat context knowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes relevant knowledge documents in the heartbeat context payload", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Refactor heartbeat dedupe",
      description: "Preserve budget hard-stop behavior while deduping heartbeats.",
      identifier: "PAP-1",
      status: "todo",
      priority: "high",
      projectId: "project-1",
      goalId: null,
      parentId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      updatedAt: new Date("2026-03-14T12:00:00.000Z"),
    });
    mockIssueService.getAncestors.mockResolvedValue([
      {
        id: "issue-parent",
        identifier: "PAP-0",
        title: "Budget hard-stop rollout",
        description: "Guard cost ceilings during runtime changes.",
        status: "in_progress",
        priority: "high",
      },
    ]);
    mockIssueService.getCommentCursor.mockResolvedValue({ lastCommentId: null, commentCount: 0 });
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      name: "Runtime",
      status: "in_progress",
      targetDate: null,
    });
    mockKnowledgeService.listRelevantForIssueContext.mockResolvedValue([
      {
        id: "doc-1",
        title: "Heartbeat budget policy",
        category: "architecture",
        tags: ["heartbeat", "budget"],
        content: "Always check hard-stop budget state before rescheduling a run.",
        truncated: false,
        updatedAt: new Date("2026-03-13T12:00:00.000Z"),
      },
    ]);

    const res = await request(createApp()).get("/api/issues/issue-1/heartbeat-context");

    expect(res.status).toBe(200);
    expect(mockKnowledgeService.listRelevantForIssueContext).toHaveBeenCalledWith("company-1", {
      title: "Refactor heartbeat dedupe",
      description: "Preserve budget hard-stop behavior while deduping heartbeats.",
      project: { name: "Runtime" },
      goal: null,
      ancestors: [
        {
          id: "issue-parent",
          identifier: "PAP-0",
          title: "Budget hard-stop rollout",
          description: "Guard cost ceilings during runtime changes.",
          status: "in_progress",
          priority: "high",
        },
      ],
    });
    expect(res.body.knowledge).toEqual([
      expect.objectContaining({
        id: "doc-1",
        title: "Heartbeat budget policy",
        category: "architecture",
      }),
    ]);
  });
});