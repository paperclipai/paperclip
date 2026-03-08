import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";

const issueServiceMock = {
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  list: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  getLabelById: vi.fn(),
  deleteLabel: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listComments: vi.fn(),
  getComment: vi.fn(),
  addComment: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  listApprovals: vi.fn(),
  addApprovalLink: vi.fn(),
  removeApprovalLink: vi.fn(),
  addAttachmentMetadata: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  deleteAttachment: vi.fn(),
};

vi.mock("../services/index.js", () => ({
  issueService: () => issueServiceMock,
  accessService: () => ({
    canUser: vi.fn().mockResolvedValue(true),
    hasPermission: vi.fn().mockResolvedValue(false),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(),
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
    cancelRun: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn().mockResolvedValue([]),
  }),
  goalService: () => ({
    getById: vi.fn(),
  }),
  issueApprovalService: () => ({
    attachIssue: vi.fn(),
    detachIssue: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      source: "agent_key",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-actor",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue routes run ownership conflicts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 with checkout run id on patch ownership conflict", async () => {
    const app = createApp();
    issueServiceMock.getByIdentifier.mockResolvedValue(null);
    issueServiceMock.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByUserId: null,
    });
    issueServiceMock.assertCheckoutOwner.mockRejectedValue(
      new HttpError(409, "Issue run ownership conflict", { checkoutRunId: "run-owner" }),
    );

    const res = await request(app).patch("/api/issues/issue-1").send({ title: "new title" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Issue is checked out by run run-owner" });
  });

  it("returns 403 with checkout run id on comment ownership conflict", async () => {
    const app = createApp();
    issueServiceMock.getByIdentifier.mockResolvedValue(null);
    issueServiceMock.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      executionRunId: "run-owner",
    });
    issueServiceMock.assertCheckoutOwner.mockRejectedValue(
      new HttpError(409, "Issue run ownership conflict", { checkoutRunId: "run-owner" }),
    );

    const res = await request(app).post("/api/issues/issue-1/comments").send({ body: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Issue is checked out by run run-owner" });
  });
});
