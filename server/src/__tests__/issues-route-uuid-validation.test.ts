import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  checkout: vi.fn(),
  listComments: vi.fn(),
  getByIdentifier: vi.fn(),
  getAttachmentById: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  unlink: vi.fn(),
}));

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

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
  heartbeatService: () => mockHeartbeat,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverride,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issues routes UUID validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: COMPANY_ID,
      status: "todo",
    });
    mockIssueService.checkout.mockResolvedValue(null);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getAttachmentById.mockResolvedValue(null);
    mockWorkProductService.getById.mockResolvedValue(null);
    mockIssueApprovalService.unlink.mockResolvedValue(undefined);
    mockHeartbeat.wakeup.mockResolvedValue(undefined);
    mockHeartbeat.reportRunActivity.mockResolvedValue(undefined);
  });

  it("returns 400 for invalid UUID-based list filters", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/issues?projectId=not-a-uuid`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("projectId");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid companyId path on company-scoped issue routes", async () => {
    const res = await request(createApp()).get("/api/companies/not-a-uuid/issues");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("companyId");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid issue id path on comments routes", async () => {
    const res = await request(createApp()).get("/api/issues/not-a-uuid/comments");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid issue id");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid comment cursor in comment list query", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?after=not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("after comment cursor");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 400 when duplicate after cursors resolve to an invalid first value", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?after=not-a-uuid&after=22222222-2222-4222-8222-222222222222",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("after comment cursor");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 400 when after and afterCommentId cursors conflict", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?after=22222222-2222-4222-8222-222222222222&afterCommentId=33333333-3333-4333-8333-333333333333",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Conflicting comment cursors");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("accepts equivalent after cursors that differ only by UUID case", async () => {
    const cursorUpper = "22222222-2222-4222-8222-2222222222AB";
    const cursorLower = cursorUpper.toLowerCase();
    const res = await request(createApp()).get(
      `/api/issues/11111111-1111-4111-8111-111111111111/comments?after=${cursorUpper}&afterCommentId=${cursorLower}`,
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        afterCommentId: cursorLower,
      }),
    );
  });

  it("returns 400 for invalid comment order query values", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?order=sideways",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid comment order");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid comment limit query values", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/comments?limit=0",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid comment limit");
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("returns 401 for agent checkout when runId is malformed non-string", async () => {
    const agentId = "33333333-3333-4333-8333-333333333333";
    const app = createApp({
      type: "agent",
      companyId: COMPANY_ID,
      agentId,
      runId: { bad: true },
    });
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("run id");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("returns 401 for agent checkout when runId is malformed non-uuid string", async () => {
    const agentId = "33333333-3333-4333-8333-333333333333";
    const app = createApp({
      type: "agent",
      companyId: COMPANY_ID,
      agentId,
      runId: "run-1",
    });
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("run id");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("does not enqueue assignee wakeup for checkout no-op when issue already owned in-progress", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const agentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
    });
    mockIssueService.checkout.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("treats equivalent assignee ids as checkout no-op even when request id casing differs", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const assigneeLower = "33333333-3333-4333-8333-333333333333";
    const assigneeUpper = assigneeLower.toUpperCase();
    mockIssueService.getById.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: assigneeLower,
      checkoutRunId: null,
    });
    mockIssueService.checkout.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: assigneeLower,
      checkoutRunId: null,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: assigneeUpper, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      issueId,
      assigneeLower,
      ["in_progress"],
      null,
    );
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("allows agent checkout as self when ids differ only by case/whitespace", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const agentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
    });
    mockIssueService.checkout.mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: "44444444-4444-4444-8444-444444444444",
    });
    const app = createApp({
      type: "agent",
      companyId: COMPANY_ID,
      agentId: ` ${agentId.toUpperCase()} `,
      runId: "44444444-4444-4444-8444-444444444444",
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      issueId,
      agentId,
      ["todo"],
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("returns 400 for invalid attachment ids before attachment lookup", async () => {
    const res = await request(createApp()).get("/api/attachments/not-a-uuid/content");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("attachmentId");
    expect(mockIssueService.getAttachmentById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid work-product ids before work-product lookup", async () => {
    const res = await request(createApp())
      .patch("/api/work-products/not-a-uuid")
      .send({ title: "noop" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("work product id");
    expect(mockWorkProductService.getById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid approval ids before unlinking issue approvals", async () => {
    const res = await request(createApp()).delete(
      "/api/issues/11111111-1111-4111-8111-111111111111/approvals/not-a-uuid",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("approvalId");
    expect(mockIssueApprovalService.unlink).not.toHaveBeenCalled();
  });
});
