import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  documentService: () => mockDocumentService,
  accessService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn() }),
  agentService: () => ({}),
  projectService: () => ({}),
  goalService: () => ({}),
  issueApprovalService: () => ({}),
  executionWorkspaceService: () => ({}),
  workProductService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn() }),
  logActivity: mockLogActivity,
}));

const ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  checkoutRunId: "run-old",
};

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("document PUT checkout ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(ISSUE);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects document PUT from agent with mismatched checkout run", async () => {
    mockIssueService.assertCheckoutOwner.mockRejectedValue(
      conflict("Issue run ownership conflict — checkout expired or reassigned, do not retry", {
        issueId: ISSUE.id,
        checkoutRunId: "run-old",
        actorRunId: "run-stale",
        retryable: false,
      }),
    );

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-stale",
    });

    const res = await request(app)
      .put("/api/issues/issue-1/documents/plan")
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\nSome content",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("checkout expired");
    expect(res.body.details.retryable).toBe(false);
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("allows document PUT from agent with valid checkout run", async () => {
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      ...ISSUE,
      adoptedFromRunId: null,
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: true,
      document: {
        id: "doc-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 1,
      },
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-old",
    });

    const res = await request(app)
      .put("/api/issues/issue-1/documents/plan")
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\nSome content",
      });

    expect(res.status).toBe(201);
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledTimes(1);
  });

  it("logs checkout adoption when agent takes over a stale run", async () => {
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      ...ISSUE,
      checkoutRunId: "run-new",
      adoptedFromRunId: "run-old",
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: true,
      document: {
        id: "doc-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 1,
      },
    });

    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-new",
    });

    const res = await request(app)
      .put("/api/issues/issue-1/documents/plan")
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\nContent",
      });

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.checkout_lock_adopted" }),
    );
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledTimes(1);
  });

  it("allows document PUT from board users without checkout check", async () => {
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        id: "doc-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .put("/api/issues/issue-1/documents/plan")
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\nUpdated content",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledTimes(1);
  });
});
