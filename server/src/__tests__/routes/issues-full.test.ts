import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  markRead: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  getLabelById: vi.fn(),
  deleteLabel: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  listAttachments: vi.fn(),
  getAttachment: vi.fn(),
  createAttachmentMetadata: vi.fn(),
  removeAttachment: vi.fn(),
  processMentionNotifications: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn().mockResolvedValue(null),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  listIssueDocuments: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
  upsertIssueDocument: vi.fn(),
  listIssueDocumentRevisions: vi.fn(),
  deleteIssueDocument: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  issueApprovalService: () => mockIssueApprovalService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../routes/issues-checkout-wakeup.js", () => ({
  shouldWakeAssigneeOnCheckout: vi.fn().mockReturnValue(false),
}));

vi.mock("../../attachment-types.js", () => ({
  isAllowedContentType: vi.fn().mockReturnValue(true),
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
}));

const mockStorage = {
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
};

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorage as any));
  app.use(errorHandler);
  return app;
}

describe("issueRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.processMentionNotifications.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
  });

  describe("GET /companies/:companyId/issues", () => {
    it("lists issues for company", async () => {
      mockIssueService.list.mockResolvedValue([{ id: "i1", title: "Bug" }]);
      const res = await request(createApp()).get("/api/companies/company-1/issues");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/issues");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /issues (malformed path)", () => {
    it("returns 400", async () => {
      const res = await request(createApp()).get("/api/issues");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /issues/:id", () => {
    it("returns an issue", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", title: "Bug", projectId: null, goalId: null,
      });
      const res = await request(createApp()).get("/api/issues/i1");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Bug");
    });

    it("returns 404 for nonexistent issue", async () => {
      mockIssueService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/issues/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:companyId/issues (create)", () => {
    it("creates an issue", async () => {
      mockIssueService.create.mockResolvedValue({ id: "i2", companyId: "company-1", title: "New" });
      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "New", type: "task" });
      expect(res.status).toBe(201);
    });

    it("processes create-time description mentions and dispatches resulting wakeups", async () => {
      mockIssueService.create.mockResolvedValue({
        id: "i2",
        companyId: "company-1",
        title: "New",
        identifier: "PAP-2",
        description: "Please sync with @Genie DevRel.",
        status: "todo",
        assigneeAgentId: null,
      });
      mockIssueService.processMentionNotifications.mockImplementation(async (args: { wakeups: Map<string, unknown> }) => {
        const { wakeups } = args;
        wakeups.set("agent-mentioned", {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: "i2" },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
          contextSnapshot: {
            issueId: "i2",
            taskId: "i2",
            wakeReason: "issue_comment_mentioned",
            source: "issue.create.mention",
          },
        });
      });

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "New", description: "Please sync with @Genie DevRel.", type: "task" });

      await new Promise((resolve) => setImmediate(resolve));

      expect(res.status).toBe(201);
      expect(mockIssueService.processMentionNotifications).toHaveBeenCalledTimes(1);

      const call = mockIssueService.processMentionNotifications.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        companyId: "company-1",
        issueId: "i2",
        issueTitle: "New",
        issueIdentifier: "PAP-2",
        body: "Please sync with @Genie DevRel.",
        actor: {
          actorType: "user",
          actorId: "user-1",
          agentId: null,
          runId: null,
        },
        contextSource: "issue.create.mention",
      });
      expect(call.commentId).toBeUndefined();
      expect(call.wakeups).toBeInstanceOf(Map);

      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "agent-mentioned",
        expect.objectContaining({
          reason: "issue_comment_mentioned",
          payload: { issueId: "i2" },
        }),
      );
    });
  });

  describe("PATCH /issues/:id (update)", () => {
    it("updates an issue", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", title: "Old", status: "open",
        assigneeAgentId: null,
      });
      mockIssueService.update.mockResolvedValue({ id: "i1", companyId: "company-1", title: "Updated" });
      const res = await request(createApp())
        .patch("/api/issues/i1")
        .send({ title: "Updated" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent issue on update", async () => {
      mockIssueService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch("/api/issues/missing")
        .send({ title: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /issues/:id/checkout", () => {
    const AGENT_UUID = "00000000-0000-0000-0000-000000000001";

    it("checks out an issue", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", status: "open", assigneeAgentId: AGENT_UUID,
      });
      mockIssueService.checkout.mockResolvedValue({ id: "i1", status: "in_progress" });
      mockAgentService.getById.mockResolvedValue({ id: AGENT_UUID, companyId: "company-1" });
      const res = await request(createApp({
        type: "agent", agentId: AGENT_UUID, companyId: "company-1", runId: "run-1",
      }))
        .post("/api/issues/i1/checkout")
        .send({ agentId: AGENT_UUID, expectedStatuses: ["todo"] });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /issues/:id/release", () => {
    const AGENT_UUID = "00000000-0000-0000-0000-000000000001";

    it("releases an issue", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", status: "in_progress", assigneeAgentId: AGENT_UUID,
      });
      mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
      mockIssueService.release.mockResolvedValue({ id: "i1", status: "open" });
      const res = await request(createApp({
        type: "agent", agentId: AGENT_UUID, companyId: "company-1", runId: "run-1",
      }))
        .post("/api/issues/i1/release")
        .send({});
      expect(res.status).toBe(200);
    });
  });

  describe("assignment with tasks:assign_scope subtree enforcement", () => {
    const CEO_AGENT = "00000000-0000-0000-0000-000000000010";
    const TARGET_AGENT = "00000000-0000-0000-0000-000000000011";
    const OTHER_AGENT = "00000000-0000-0000-0000-000000000012";

    it("allows assignment within scope subtree", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", title: "Task", status: "open",
        assigneeAgentId: null,
      });
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.hasPermission.mockResolvedValue({
        granted: true,
        scope: { subtree: CEO_AGENT },
      });
      mockAgentService.getChainOfCommand.mockResolvedValue([{ id: CEO_AGENT }]);
      mockIssueService.update.mockResolvedValue({
        id: "i1", companyId: "company-1", assigneeAgentId: TARGET_AGENT,
      });
      const res = await request(createApp())
        .patch("/api/issues/i1")
        .send({ assigneeAgentId: TARGET_AGENT });
      expect(res.status).toBe(200);
    });

    it("returns 403 when assigning outside scope subtree", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "i1", companyId: "company-1", title: "Task", status: "open",
        assigneeAgentId: null,
      });
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.hasPermission.mockResolvedValue({
        granted: true,
        scope: { subtree: CEO_AGENT },
      });
      mockAgentService.getChainOfCommand.mockResolvedValue([{ id: OTHER_AGENT }]);
      const res = await request(createApp())
        .patch("/api/issues/i1")
        .send({ assigneeAgentId: TARGET_AGENT });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /companies/:companyId/labels", () => {
    it("lists labels", async () => {
      mockIssueService.listLabels.mockResolvedValue([{ id: "l1", name: "bug" }]);
      const res = await request(createApp()).get("/api/companies/company-1/labels");
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /labels/:labelId", () => {
    it("deletes a label", async () => {
      mockIssueService.getLabelById.mockResolvedValue({ id: "l1", companyId: "company-1", name: "bug" });
      mockIssueService.deleteLabel.mockResolvedValue({ id: "l1", companyId: "company-1", name: "bug" });
      const res = await request(createApp()).delete("/api/labels/l1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent label", async () => {
      mockIssueService.getLabelById.mockResolvedValue(null);
      const res = await request(createApp()).delete("/api/labels/missing");
      expect(res.status).toBe(404);
    });
  });
});
