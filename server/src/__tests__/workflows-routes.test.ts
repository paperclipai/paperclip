import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const handoffId = "44444444-4444-4444-8444-444444444444";
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockWorkflowHandoffBridgeService = vi.hoisted(() => vi.fn());

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
  applyTelemetryEvents: vi.fn(),
  createRuntimeHandoff: vi.fn(),
  submitRunFeedback: vi.fn(),
  listRunEvents: vi.fn(),
  listRunAssets: vi.fn(),
  getRunReview: vi.fn(),
  publishRunReview: vi.fn(),
  publishRunAssets: vi.fn(),
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
  workflowHandoffBridgeService: mockWorkflowHandoffBridgeService,
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
    mockWorkflowHandoffBridgeService.mockReturnValue({ openForHandoff: vi.fn() });
  });

  it("returns the ClickUp bridge error when a runtime handoff cannot be delivered", async () => {
    const handoff = {
      id: "handoff-1",
      companyId,
      workflowRunId: runId,
      kind: "approval",
      phaseKey: "review",
      promptMarkdown: "Approve this draft.",
      status: "pending",
    };
    const openForHandoff = vi.fn().mockRejectedValue(Object.assign(
      new Error("ClickUp integration is not configured"),
      { status: 503 },
    ));
    mockWorkflowHandoffBridgeService.mockReturnValue({ openForHandoff });
    mockWorkflowService.verifyRuntimeToken.mockResolvedValue(true);
    mockWorkflowService.createRuntimeHandoff.mockResolvedValue(handoff);

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/handoffs/runtime`)
      .send({
        token: "runtime-token",
        phaseKey: "review",
        kind: "approval",
        stage: "content",
        eventPhase: "grounding",
        reviewSummary: "Source check complete. Planning will use Databricks UGC submissions. Not used: Homemade Genie SODA.",
        idempotencyKey: "handoff-review-0",
        promptMarkdown: "Approve this draft.",
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "ClickUp integration is not configured" });
    expect(mockWorkflowService.createRuntimeHandoff).toHaveBeenCalledWith(runId, {
      phaseKey: "review",
      kind: "approval",
      stage: "content",
      eventPhase: "grounding",
      reviewSummary: "Source check complete. Planning will use Databricks UGC submissions. Not used: Homemade Genie SODA.",
      idempotencyKey: "handoff-review-0",
      promptMarkdown: "Approve this draft.",
    });
    expect(openForHandoff).toHaveBeenCalledWith({
      id: handoff.id,
      companyId: handoff.companyId,
      workflowRunId: handoff.workflowRunId,
      kind: handoff.kind,
      promptMarkdown: handoff.promptMarkdown,
    });
  });

  it("submits feedback to the existing run without creating a new run", async () => {
    mockWorkflowService.getRunDetail.mockResolvedValue({
      id: runId,
      companyId,
      status: "awaiting_human",
      reviewStage: "content",
      workflow: { id: "workflow-1", title: "Social", status: "active", runnerType: "google_adk" },
    });
    mockWorkflowService.submitRunFeedback.mockResolvedValue({ revision: 1, reviewStage: "content", status: "running", duplicate: false });

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/extensions/citro-social-cms/v1/handoffs/${handoffId}/feedback`)
      .send({
        idempotencyKey: "feedback-1",
        generationId: "generation-1",
        revision: 0,
        action: "request_changes",
        stage: "content",
        instruction: "Use a warmer tone.",
        target: { scope: "copy" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "running",
      reviewState: "revision_requested",
      reviewStage: "content",
      revision: 1,
      duplicate: false,
    });
    expect(mockWorkflowService.submitRunFeedback).toHaveBeenCalledWith(runId, handoffId, {
      idempotencyKey: "feedback-1",
      generationId: "generation-1",
      revision: 0,
      action: "request_changes",
      stage: "content",
      instruction: "Use a warmer tone.",
      target: { scope: "copy" },
    }, { userId: "board-user" });
    expect(mockWorkflowService.runManual).not.toHaveBeenCalled();
  });

  it("returns chronological events and derived run assets", async () => {
    mockWorkflowService.getRunDetail.mockResolvedValue({
      id: runId,
      companyId,
      status: "awaiting_human",
      reviewStage: "content",
      workflow: { id: "workflow-1", title: "Social", status: "active", runnerType: "google_adk" },
    });
    mockWorkflowService.listRunEvents.mockResolvedValue({ events: [{ id: "evt-1" }], nextCursor: "evt-1" });
    mockWorkflowService.listRunAssets.mockResolvedValue([{ id: "asset-1", deliverableId: "asset-1", screenNumber: null, templateId: null, viewableUrl: "/api/deliverables/asset-1/content", thumbnailUrl: null, superseded: false }]);

    const events = await request(createApp()).get(`/api/workflow-runs/${runId}/extensions/citro-social-cms/v1/events?after=evt-0`);
    const assets = await request(createApp()).get(`/api/workflow-runs/${runId}/extensions/citro-social-cms/v1/assets`);

    expect(events.status).toBe(200);
    expect(events.body).toEqual({ events: [{ id: "evt-1" }], nextCursor: "evt-1" });
    expect(mockWorkflowService.listRunEvents).toHaveBeenCalledWith(runId, "evt-0");
    expect(assets.status).toBe(200);
    expect(assets.body).toMatchObject({ assets: [{
      id: "asset-1", deliverableId: "asset-1", screenNumber: 1, templateId: "workflow-deliverable",
      postType: "single_image", status: "generated",
    }] });
    expect(assets.body.assets[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/deliverables\/asset-1\/content$/);
    expect(assets.body.assets[0].thumbnailUrl).toBe(assets.body.assets[0].url);
  });

  it("does not expose Social CMS resources on generic workflow routes", async () => {
    const [feedback, events, assets, review] = await Promise.all([
      request(createApp()).post(`/api/workflow-runs/${runId}/feedback`).send({}),
      request(createApp()).get(`/api/workflow-runs/${runId}/events`),
      request(createApp()).get(`/api/workflow-runs/${runId}/assets`),
      request(createApp()).get(`/api/workflow-runs/${runId}/review`),
    ]);

    expect(feedback.status).toBe(404);
    expect(events.status).toBe(404);
    expect(assets.status).toBe(404);
    expect(review.status).toBe(404);
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

  it("authenticates and ingests versioned runtime telemetry batches", async () => {
    mockWorkflowService.verifyRuntimeToken.mockResolvedValue(true);
    mockWorkflowService.applyTelemetryEvents.mockResolvedValue({ accepted: 1, duplicates: 0 });
    const event = {
      schema: "bizbox.telemetry/v1",
      event: "operation.completed",
      eventId: "evt-1",
      spanId: "tool-1",
      parentSpanId: "agent-1",
      sequence: 2,
      timestamp: "2026-08-12T00:00:00.000Z",
      actor: { kind: "tool", name: "partnerpal" },
      operation: { kind: "tool", name: "partnerpal" },
      status: "succeeded",
      output: { matches: 1 },
    };

    const res = await request(createApp())
      .post(`/api/workflow-runs/${runId}/runtime/telemetry-events`)
      .send({ token: "runtime-token", events: [event] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1, duplicates: 0 });
    expect(mockWorkflowService.applyTelemetryEvents).toHaveBeenCalledWith(runId, [event]);
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
