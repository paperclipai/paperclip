import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWorkflowTemplateService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  invoke: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  workflowTemplateService: () => mockWorkflowTemplateService,
  logActivity: mockLogActivity,
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

const COMPANY_ID = "company-1";
const TEMPLATE_ID = "tmpl-1";

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};

const AGENT_ACTOR = {
  type: "agent",
  agentId: "agent-1",
  companyId: COMPANY_ID,
  source: "agent_key",
  runId: "run-1",
};

function sampleTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    companyId: COMPANY_ID,
    name: "Hiring SOP",
    description: "Standard hiring workflow",
    nodes: [
      {
        tempId: "$gather",
        title: "Gather requirements",
        description: null,
        blockedByTempIds: [],
      },
      {
        tempId: "$research",
        title: "Research agent design",
        description: null,
        blockedByTempIds: ["$gather"],
      },
    ],
    createdByUserId: "user-1",
    createdByAgentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  const [{ errorHandler }, { workflowTemplateRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/workflow-templates.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", workflowTemplateRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("workflow template routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // ── List ─────────────────────────────────────────────────────────────

  it("lists workflow templates for a company", async () => {
    const templates = [sampleTemplate()];
    mockWorkflowTemplateService.list.mockResolvedValue(templates);

    const app = await createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/workflow-templates`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(templates);
    expect(mockWorkflowTemplateService.list).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("rejects listing templates for a company the user does not belong to", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-other/workflow-templates");

    expect(res.status).toBe(403);
    expect(mockWorkflowTemplateService.list).not.toHaveBeenCalled();
  });

  // ── Create ───────────────────────────────────────────────────────────

  it("creates a workflow template and logs activity", async () => {
    const template = sampleTemplate();
    mockWorkflowTemplateService.create.mockResolvedValue(template);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/workflow-templates`)
      .send({
        name: "Hiring SOP",
        description: "Standard hiring workflow",
        nodes: template.nodes,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(template);
    expect(mockWorkflowTemplateService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ name: "Hiring SOP" }),
      { agentId: null, userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "workflow_template.created",
        entityType: "workflow_template",
        entityId: TEMPLATE_ID,
      }),
    );
  });

  it("rejects creating a template in another company", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-other/workflow-templates")
      .send({
        name: "Test",
        nodes: [{ tempId: "$root", title: "Root", blockedByTempIds: [] }],
      });

    expect(res.status).toBe(403);
    expect(mockWorkflowTemplateService.create).not.toHaveBeenCalled();
  });

  // ── Get ──────────────────────────────────────────────────────────────

  it("returns a single workflow template", async () => {
    const template = sampleTemplate();
    mockWorkflowTemplateService.get.mockResolvedValue(template);

    const app = await createApp();
    const res = await request(app).get(`/api/workflow-templates/${TEMPLATE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(template);
  });

  it("returns 404 when the template does not exist", async () => {
    mockWorkflowTemplateService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/api/workflow-templates/missing");

    expect(res.status).toBe(404);
  });

  it("rejects access to a template in another company", async () => {
    const template = sampleTemplate({ companyId: "company-other" });
    mockWorkflowTemplateService.get.mockResolvedValue(template);

    const app = await createApp();
    const res = await request(app).get(`/api/workflow-templates/${TEMPLATE_ID}`);

    expect(res.status).toBe(403);
  });

  // ── Update ───────────────────────────────────────────────────────────

  it("updates a workflow template and logs activity", async () => {
    const existing = sampleTemplate();
    const updated = sampleTemplate({ name: "Updated SOP" });
    mockWorkflowTemplateService.get.mockResolvedValue(existing);
    mockWorkflowTemplateService.update.mockResolvedValue(updated);

    const app = await createApp();
    const res = await request(app)
      .patch(`/api/workflow-templates/${TEMPLATE_ID}`)
      .send({ name: "Updated SOP" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated SOP");
    expect(mockWorkflowTemplateService.update).toHaveBeenCalledWith(
      TEMPLATE_ID,
      expect.objectContaining({ name: "Updated SOP" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow_template.updated",
        entityId: TEMPLATE_ID,
      }),
    );
  });

  it("returns 404 when updating a non-existent template", async () => {
    mockWorkflowTemplateService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app)
      .patch("/api/workflow-templates/missing")
      .send({ name: "Updated" });

    expect(res.status).toBe(404);
    expect(mockWorkflowTemplateService.update).not.toHaveBeenCalled();
  });

  // ── Delete ───────────────────────────────────────────────────────────

  it("deletes a workflow template and logs activity", async () => {
    const existing = sampleTemplate();
    mockWorkflowTemplateService.get.mockResolvedValue(existing);
    mockWorkflowTemplateService.remove.mockResolvedValue(true);

    const app = await createApp();
    const res = await request(app).delete(`/api/workflow-templates/${TEMPLATE_ID}`);

    expect(res.status).toBe(204);
    expect(mockWorkflowTemplateService.remove).toHaveBeenCalledWith(TEMPLATE_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow_template.deleted",
        entityId: TEMPLATE_ID,
      }),
    );
  });

  it("returns 404 when deleting a non-existent template", async () => {
    mockWorkflowTemplateService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).delete("/api/workflow-templates/missing");

    expect(res.status).toBe(404);
    expect(mockWorkflowTemplateService.remove).not.toHaveBeenCalled();
  });

  // ── Invoke ───────────────────────────────────────────────────────────

  it("invokes a workflow template and logs activity", async () => {
    const existing = sampleTemplate();
    const invokeResult = {
      rootIssueId: "issue-root",
      createdIssues: [
        { tempId: "$gather", issueId: "issue-1", title: "Gather requirements", status: "todo" as const, assigneeAgentId: "agent-1" },
        { tempId: "$research", issueId: "issue-2", title: "Research agent design", status: "blocked" as const, assigneeAgentId: null },
      ],
    };
    mockWorkflowTemplateService.get.mockResolvedValue(existing);
    mockWorkflowTemplateService.invoke.mockResolvedValue(invokeResult);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/workflow-templates/${TEMPLATE_ID}/invoke`)
      .send({ context: "Hiring a new QA agent" });

    expect(res.status).toBe(201);
    expect(res.body.rootIssueId).toBe("issue-root");
    expect(res.body.createdIssues).toHaveLength(2);
    expect(mockWorkflowTemplateService.invoke).toHaveBeenCalledWith(
      COMPANY_ID,
      TEMPLATE_ID,
      expect.objectContaining({ context: "Hiring a new QA agent" }),
      { agentId: null, userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow_template.invoked",
        entityId: TEMPLATE_ID,
        details: expect.objectContaining({
          rootIssueId: "issue-root",
          issueCount: 2,
        }),
      }),
    );
  });

  it("queues assignment wakeups for unblocked issues with assignees after invoke", async () => {
    const existing = sampleTemplate();
    const invokeResult = {
      rootIssueId: "issue-1",
      createdIssues: [
        { tempId: "$gather", issueId: "issue-1", title: "Gather", status: "todo" as const, assigneeAgentId: "agent-1" },
        { tempId: "$research", issueId: "issue-2", title: "Research", status: "blocked" as const, assigneeAgentId: "agent-2" },
      ],
    };
    mockWorkflowTemplateService.get.mockResolvedValue(existing);
    mockWorkflowTemplateService.invoke.mockResolvedValue(invokeResult);

    const app = await createApp();
    await request(app)
      .post(`/api/workflow-templates/${TEMPLATE_ID}/invoke`)
      .send({});

    // Only the "todo" issue with an assignee should get a wakeup
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledTimes(1);
    expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: expect.objectContaining({
          id: "issue-1",
          assigneeAgentId: "agent-1",
          status: "todo",
        }),
        reason: "issue_assigned",
        mutation: "workflow_invoke",
      }),
    );
  });

  it("returns 404 when invoking a non-existent template", async () => {
    mockWorkflowTemplateService.get.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app)
      .post("/api/workflow-templates/missing/invoke")
      .send({});

    expect(res.status).toBe(404);
    expect(mockWorkflowTemplateService.invoke).not.toHaveBeenCalled();
  });

  // ── Agent access ─────────────────────────────────────────────────────

  it("allows agent callers to list templates in their company", async () => {
    mockWorkflowTemplateService.list.mockResolvedValue([]);

    const app = await createApp(AGENT_ACTOR);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/workflow-templates`);

    expect(res.status).toBe(200);
    expect(mockWorkflowTemplateService.list).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("rejects anonymous callers", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/workflow-templates`);

    expect(res.status).toBe(401);
    expect(mockWorkflowTemplateService.list).not.toHaveBeenCalled();
  });
});
