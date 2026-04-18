import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  listComments: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({}));
const mockAgentService = vi.hoisted(() => ({}));
const mockExecutionWorkspaceService = vi.hoisted(() => ({}));
const mockGoalService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockDocumentService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProjectService = vi.hoisted(() => ({}));
const mockWorkProductService = vi.hoisted(() => ({}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

describe("GET /api/issues/:id/comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
  });

  it("returns comments without cursor", async () => {
    const comments = [
      { id: "c1", body: "hello", createdAt: new Date("2026-03-01T00:00:00Z") },
    ];
    mockIssueService.listComments.mockResolvedValue(comments);

    const res = await request(createApp()).get("/api/issues/issue-1/comments");

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: null,
      order: "desc",
      limit: null,
    });
    expect(res.body).toHaveLength(1);
  });

  it("passes after cursor and order=asc to service", async () => {
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/issues/issue-1/comments?after=comment-abc&order=asc",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: "comment-abc",
      order: "asc",
      limit: null,
    });
  });

  it("accepts afterCommentId as an alias for after", async () => {
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/issues/issue-1/comments?afterCommentId=comment-xyz",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: "comment-xyz",
      order: "desc",
      limit: null,
    });
  });

  it("clamps limit to 500", async () => {
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/issues/issue-1/comments?limit=9999",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: null,
      order: "desc",
      limit: 500,
    });
  });

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/issues/missing/comments");

    expect(res.status).toBe(404);
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("defaults to desc order when order param is missing", async () => {
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/issues/issue-1/comments?after=c1",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: "c1",
      order: "desc",
      limit: null,
    });
  });

  it("ignores empty after param", async () => {
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/issues/issue-1/comments?after=",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith("issue-1", {
      afterCommentId: null,
      order: "desc",
      limit: null,
    });
  });
});
