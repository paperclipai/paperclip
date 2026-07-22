import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const mockLogActivity = vi.hoisted(() => vi.fn());

const mockWorkflowService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getDetail: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  runManual: vi.fn(),
  getRunDetail: vi.fn(),
  cancelRun: vi.fn(),
  getHandoff: vi.fn(),
  resolveHandoff: vi.fn(),
  verifyRuntimeToken: vi.fn(),
  applyPhaseEvent: vi.fn(),
  createRuntimeHandoff: vi.fn(),
}));
const mockWorkflowScheduleService = vi.hoisted(() => ({
  listForWorkflow: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  tickScheduledRuns: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  workflowService: () => mockWorkflowService,
  workflowScheduleService: () => mockWorkflowScheduleService,
  logActivity: mockLogActivity,
}));

import { workflowRoutes } from "../routes/workflows.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, status: "active", membershipRole: "admin" }],
    };
    next();
  });
  app.use("/api", workflowRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when a runtime phase event targets an unknown phase key", async () => {
    mockWorkflowService.verifyRuntimeToken.mockResolvedValue(true);
    mockWorkflowService.applyPhaseEvent.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/runtime/phase-events`)
      .send({
        token: "runtime-token",
        phaseKey: "missing-phase",
        status: "running",
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Workflow phase not found for key: missing-phase" });
    expect(mockWorkflowService.applyPhaseEvent).toHaveBeenCalledWith(runId, {
      phaseKey: "missing-phase",
      status: "running",
    });
  });

  it("forwards includeArchived list query to workflow service", async () => {
    mockWorkflowService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .get(`/api/companies/${companyId}/workflows?includeArchived=true`);

    expect(res.status).toBe(200);
    expect(mockWorkflowService.list).toHaveBeenCalledWith(companyId, { includeArchived: true });
  });

  it("logs dedicated archive and restore activity actions", async () => {
    mockWorkflowService.get
      .mockResolvedValueOnce({
      id: "workflow-1",
      companyId,
      title: "Social",
      status: "active",
      })
      .mockResolvedValueOnce({
        id: "workflow-1",
        companyId,
        title: "Social",
        status: "archived",
      });
    mockWorkflowService.update
      .mockResolvedValueOnce({ id: "workflow-1", companyId, title: "Social", status: "archived" })
      .mockResolvedValueOnce({ id: "workflow-1", companyId, title: "Social", status: "active" });

    const archive = await request(createApp())
      .patch("/api/workflows/workflow-1")
      .send({ status: "archived" });
    const restore = await request(createApp())
      .patch("/api/workflows/workflow-1")
      .send({ status: "active" });

    expect(archive.status).toBe(200);
    expect(restore.status).toBe(200);
    expect(mockLogActivity).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      action: "workflow.archived",
      details: expect.objectContaining({ previousStatus: "active", newStatus: "archived" }),
    }));
    expect(mockLogActivity).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      action: "workflow.restored",
      details: expect.objectContaining({ previousStatus: "archived", newStatus: "active" }),
    }));
  });

  it("rejects archived workflows being changed to paused", async () => {
    mockWorkflowService.get.mockResolvedValue({
      id: "workflow-1",
      companyId,
      title: "Social",
      status: "archived",
    });

    const res = await request(createApp())
      .patch("/api/workflows/workflow-1")
      .send({ status: "paused" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Archived workflows can only be restored to active. Restore the workflow before making other changes.",
    });
    expect(mockWorkflowService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows metadata edits while keeping archived status", async () => {
    mockWorkflowService.get.mockResolvedValue({
      id: "workflow-1",
      companyId,
      title: "Social",
      status: "archived",
    });
    mockWorkflowService.update.mockResolvedValue({
      id: "workflow-1",
      companyId,
      title: "Updated Social",
      status: "archived",
    });

    const res = await request(createApp())
      .patch("/api/workflows/workflow-1")
      .send({ title: "Updated Social", status: "archived" });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.update).toHaveBeenCalledWith(
      "workflow-1",
      { title: "Updated Social", status: "archived" },
      { userId: "board-user" },
    );
  });

  it("returns 409 when the HTTP run endpoint targets an archived workflow", async () => {
    mockWorkflowService.get.mockResolvedValue({
      id: "workflow-1",
      companyId,
      title: "Social",
      status: "archived",
    });
    mockWorkflowService.runManual.mockRejectedValue(
      new HttpError(409, 'Workflow "Social" is archived. Restore it before running.'),
    );

    const res = await request(createApp())
      .post("/api/workflows/workflow-1/run")
      .send({ inputMarkdown: "Run this workflow." });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Workflow "Social" is archived. Restore it before running.' });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("cancels a workflow run", async () => {
    mockWorkflowService.getRunDetail.mockResolvedValue({
      id: runId,
      companyId,
      status: "running",
      workflow: { id: "workflow-1", title: "Social", status: "active", runnerType: "google_adk" },
      phases: [],
      handoffs: [],
      deliverables: [],
    });
    mockWorkflowService.cancelRun.mockResolvedValue({
      id: runId,
      companyId,
      status: "cancelled",
    });

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/cancel`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: runId, status: "cancelled" });
    expect(mockWorkflowService.cancelRun).toHaveBeenCalledWith(runId, { userId: "board-user" });
  });

  it("returns 409 when cancelling an already-terminal workflow run", async () => {
    mockWorkflowService.getRunDetail.mockResolvedValue({
      id: runId,
      companyId,
      status: "succeeded",
      workflow: { id: "workflow-1", title: "Social", status: "active", runnerType: "google_adk" },
      phases: [],
      handoffs: [],
      deliverables: [],
    });

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/cancel`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Workflow run is already in a terminal state" });
    expect(mockWorkflowService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("creates a workflow schedule", async () => {
    mockWorkflowService.get.mockResolvedValue({
      id: "workflow-1",
      companyId,
    });
    mockWorkflowScheduleService.create.mockResolvedValue({
      id: "schedule-1",
      companyId,
      workflowId: "workflow-1",
      title: "Daily brief",
      status: "active",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      templateMarkdown: "Send the brief.",
      lastFiredAt: null,
      nextRunAt: new Date("2026-06-10T09:00:00.000Z"),
      createdByUserId: "board-user",
      updatedByUserId: "board-user",
      createdAt: new Date("2026-06-10T08:00:00.000Z"),
      updatedAt: new Date("2026-06-10T08:00:00.000Z"),
    });

    const res = await request(createApp())
      .post(`/api/workflows/workflow-1/schedules`)
      .send({
        title: "Daily brief",
        cronExpression: "0 9 * * *",
        templateMarkdown: "Send the brief.",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "schedule-1",
      title: "Daily brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the brief.",
      timezone: "UTC",
    });
    expect(mockWorkflowScheduleService.create).toHaveBeenCalledWith(
      "workflow-1",
      {
        title: "Daily brief",
        cronExpression: "0 9 * * *",
        templateMarkdown: "Send the brief.",
        status: "active",
      },
      { userId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow.schedule_created",
        entityType: "workflow_schedule",
        entityId: "schedule-1",
      }),
    );
  });

  it("returns 404 when a workflow schedule disappears during update", async () => {
    mockWorkflowScheduleService.get.mockResolvedValue({
      id: "schedule-1",
      companyId,
      workflowId: "workflow-1",
      title: "Daily brief",
      status: "active",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      templateMarkdown: "Send the brief.",
      lastFiredAt: null,
      nextRunAt: new Date("2026-06-10T09:00:00.000Z"),
      createdByUserId: "board-user",
      updatedByUserId: "board-user",
      createdAt: new Date("2026-06-10T08:00:00.000Z"),
      updatedAt: new Date("2026-06-10T08:00:00.000Z"),
    });
    mockWorkflowService.get.mockResolvedValue({
      id: "workflow-1",
      companyId,
    });
    mockWorkflowScheduleService.update.mockResolvedValue(null);

    const res = await request(createApp())
      .patch(`/api/workflow-schedules/schedule-1`)
      .send({
        title: "Daily brief",
        cronExpression: "0 9 * * *",
        templateMarkdown: "Send the brief.",
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Workflow schedule not found" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
