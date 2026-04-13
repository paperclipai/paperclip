import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";

const baseIssue = {
  id: issueId,
  companyId,
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  identifier: "PAP-1",
  title: "Test issue",
  description: null,
  status: "backlog",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
  assigneeAdapterOverrides: null,
  requestDepth: 0,
  billingCode: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  metadata: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  originKind: "manual",
  createdByAgentId: null,
  createdByUserId: "user-1",
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  labels: [],
};

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  listLabels: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  markRead: vi.fn(),
  getIssueActivityCounters: vi.fn(),
  linkApproval: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockQueueWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn().mockResolvedValue(true) }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  agentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  goalService: () => mockGoalService,
  heartbeatService: () => ({ reportRunActivity: vi.fn() }),
  issueApprovalService: () => ({}),
  documentService: () => mockDocumentService,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      actorType: "user",
      actorId: "user-1",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockQueueWakeup.mockResolvedValue(undefined);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
  });

  describe("POST /companies/:companyId/issues", () => {
    it("accepts metadata on create and returns it", async () => {
      const meta = { source: "slack", channel: "#eng" };
      mockIssueService.create.mockResolvedValue({ ...baseIssue, metadata: meta });

      const res = await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "With metadata", metadata: meta });

      expect(res.status).toBe(201);
      expect(res.body.metadata).toEqual(meta);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ metadata: meta }),
      );
    });

    it("accepts null metadata on create", async () => {
      mockIssueService.create.mockResolvedValue({ ...baseIssue, metadata: null });

      const res = await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "No metadata", metadata: null });

      expect(res.status).toBe(201);
      expect(res.body.metadata).toBeNull();
    });

    it("omitting metadata does not send it to the service", async () => {
      mockIssueService.create.mockResolvedValue({ ...baseIssue });

      const res = await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Plain issue" });

      expect(res.status).toBe(201);
      const callArgs = mockIssueService.create.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty("metadata");
    });
  });

  describe("PATCH /issues/:id", () => {
    it("accepts metadata on update and returns it", async () => {
      const meta = { env: "staging", version: 2 };
      mockIssueService.getById.mockResolvedValue(baseIssue);
      mockIssueService.update.mockResolvedValue({ ...baseIssue, metadata: meta });

      const res = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ metadata: meta });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual(meta);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issueId,
        expect.objectContaining({ metadata: meta }),
      );
    });

    it("can clear metadata by setting it to null", async () => {
      mockIssueService.getById.mockResolvedValue({ ...baseIssue, metadata: { old: true } });
      mockIssueService.update.mockResolvedValue({ ...baseIssue, metadata: null });

      const res = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ metadata: null });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toBeNull();
    });
  });

  describe("GET /issues/:id", () => {
    it("returns metadata in issue response", async () => {
      const meta = { tracking: "abc-123" };
      mockIssueService.getById.mockResolvedValue({ ...baseIssue, metadata: meta });
      mockIssueService.getAncestors.mockResolvedValue([]);
      mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
      mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
      mockDocumentService.getIssueDocumentPayload.mockResolvedValue({});
      mockWorkProductService.listForIssue.mockResolvedValue([]);

      const res = await request(createApp()).get(`/api/issues/${issueId}`);

      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual(meta);
    });
  });
});
