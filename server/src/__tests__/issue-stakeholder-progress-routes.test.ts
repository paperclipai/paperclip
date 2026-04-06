import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const issueId = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockNotifyIssueStakeholderProgress = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  notifyIssueStakeholderProgress: mockNotifyIssueStakeholderProgress,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    identifier: "THEA-3",
    title: "Implement Slack stakeholder progress notifications",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByUserId: "local-board",
    ...overrides,
  };
}

describe("issue stakeholder progress route integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_PUBLIC_URL;
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId: "company-1",
      body: "Waiting on webhook access",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("passes before/after issue state, comment summary, and request base url to the notifier", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .set("Host", "paperclip.test")
      .send({ status: "blocked", comment: "Waiting on webhook access" });

    expect(res.status).toBe(200);
    expect(mockNotifyIssueStakeholderProgress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        existingIssue: expect.objectContaining({
          id: issueId,
          status: "in_progress",
          assigneeAgentId: "agent-1",
        }),
        issue: expect.objectContaining({
          id: issueId,
          status: "blocked",
          assigneeAgentId: "agent-1",
        }),
        comment: "Waiting on webhook access",
        baseUrl: "http://paperclip.test",
      }),
    );
  });

  it("prefers PAPERCLIP_PUBLIC_URL over the request host when present", async () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example.com/";

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .set("Host", "localhost:3100")
      .send({ status: "done", comment: "Ready for review" });

    expect(res.status).toBe(200);
    expect(mockNotifyIssueStakeholderProgress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseUrl: "https://paperclip.example.com",
      }),
    );
  });
});
