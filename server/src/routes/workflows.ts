import { type Request, type Response, Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  type CreateWorkflowHandoff,
  type CreateWorkflowSchedule,
  type WorkflowPhaseEvent,
  type WorkflowTelemetryBatch,
  createWorkflowHandoffSchema,
  createWorkflowSchema,
  createWorkflowScheduleSchema,
  resolveWorkflowHandoffSchema,
  runWorkflowSchema,
  updateWorkflowSchema,
  updateWorkflowScheduleSchema,
  workflowPhaseEventSchema,
  workflowRunFeedbackSchema,
  workflowTelemetryBatchSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { logActivity, workflowHandoffBridgeService, workflowScheduleService, workflowService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function readRuntimeToken(req: { body?: unknown; query?: unknown }) {
  const bodyToken = req.body && typeof req.body === "object" && req.body !== null && typeof (req.body as { token?: unknown }).token === "string"
    ? (req.body as { token: string }).token
    : null;
  const queryToken = req.query && typeof req.query === "object" && req.query !== null && typeof (req.query as { token?: unknown }).token === "string"
    ? (req.query as { token: string }).token
    : null;
  return bodyToken ?? queryToken ?? "";
}

export function workflowRoutes(db: Db) {
  const router = Router();
  const svc = workflowService(db);
  const scheduleSvc = workflowScheduleService(db);
  const runtimePhaseEventRequestSchema = workflowPhaseEventSchema.extend({
    token: z.string().trim().min(1),
  });
  const runtimeCreateHandoffRequestSchema = createWorkflowHandoffSchema.extend({
    token: z.string().trim().min(1),
  });
  const runtimeTelemetryRequestSchema = workflowTelemetryBatchSchema.and(z.object({
    token: z.string().trim().min(1),
  }));
  const runtimeReviewRequestSchema = z.object({
    token: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(255),
    generationId: z.string().trim().min(1).max(255),
    revision: z.number().int().min(0),
    deliverables: z.array(z.object({
      id: z.string().trim().min(1).max(255),
      title: z.string().trim().min(1).max(200),
      contentMarkdown: z.string().max(200_000),
      screens: z.array(z.object({ screenNumber: z.number().int().positive(), copy: z.string().max(20_000) })).max(100),
    })).min(1).max(50),
  });
  const runtimeAssetsRequestSchema = z.object({
    token: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(255),
    generationId: z.string().trim().min(1).max(255),
    revision: z.number().int().min(0),
    assets: z.array(z.object({
      id: z.string().trim().min(1).max(255),
      deliverableId: z.string().trim().min(1).max(255),
      screenNumber: z.number().int().positive(),
      postType: z.string().trim().min(1).max(100),
      templateId: z.string().trim().min(1).max(255),
      contentBase64: z.string().min(1).max(7_000_000),
      contentType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().default("image/png"),
    })).min(1).max(20),
  });

  router.get("/companies/:companyId/workflows", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, {
      includeArchived: req.query.includeArchived === "true",
    }));
  });

  router.post("/companies/:companyId/workflows", validate(createWorkflowSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.create(companyId, req.body, { userId: req.actor.userId ?? "board" });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.created",
      entityType: "workflow",
      entityId: created.id,
      details: { title: created.title },
    });
    res.status(201).json(created);
  });

  router.get("/workflows/:id", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/workflows/:id", validate(updateWorkflowSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (
      existing.status === "archived" &&
      req.body.status !== undefined &&
      req.body.status !== existing.status &&
      req.body.status !== "active"
    ) {
      res.status(409).json({
        error: "Archived workflows can only be restored to active. Restore the workflow before making other changes.",
      });
      return;
    }
    const updated = await svc.update(existing.id, req.body, { userId: req.actor.userId ?? "board" });
    if (!updated) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const actor = getActorInfo(req);
    const statusTransitionAction = existing.status !== updated.status
      ? updated.status === "archived"
        ? "workflow.archived"
        : existing.status === "archived" && updated.status === "active"
          ? "workflow.restored"
          : "workflow.updated"
      : "workflow.updated";
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: statusTransitionAction,
      entityType: "workflow",
      entityId: existing.id,
      details: {
        title: updated.title,
        workflowId: existing.id,
        ...(existing.status !== updated.status
          ? { previousStatus: existing.status, newStatus: updated.status }
          : {}),
      },
    });
    res.json(updated);
  });

  router.post("/workflows/:id/run", validate(runWorkflowSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.get(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const run = await svc.runManual(existing.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.run_started",
      entityType: "workflow_run",
      entityId: run.id,
      details: { workflowId: existing.id },
    });
    res.status(201).json(run);
  });

  router.get("/workflows/:id/schedules", async (req, res) => {
    assertBoard(req);
    const workflow = await svc.get(req.params.id as string);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    res.json(await scheduleSvc.listForWorkflow(workflow.id));
  });

  router.post("/workflows/:id/schedules", validate(createWorkflowScheduleSchema), async (req, res) => {
    assertBoard(req);
    const workflow = await svc.get(req.params.id as string);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    const created = await scheduleSvc.create(workflow.id, req.body as CreateWorkflowSchedule, {
      userId: req.actor.userId ?? "board",
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.schedule_created",
      entityType: "workflow_schedule",
      entityId: created.id,
      details: { workflowId: workflow.id, title: created.title },
    });
    res.status(201).json(created);
  });

  router.patch("/workflow-schedules/:id", validate(updateWorkflowScheduleSchema), async (req, res) => {
    assertBoard(req);
    const schedule = await scheduleSvc.get(req.params.id as string);
    if (!schedule) {
      res.status(404).json({ error: "Workflow schedule not found" });
      return;
    }
    const workflow = await svc.get(schedule.workflowId);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    const updated = await scheduleSvc.update(schedule.id, req.body, {
      userId: req.actor.userId ?? "board",
    });
    if (!updated) {
      res.status(404).json({ error: "Workflow schedule not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.schedule_updated",
      entityType: "workflow_schedule",
      entityId: schedule.id,
      details: { workflowId: workflow.id, title: updated.title },
    });
    res.json(updated);
  });

  router.delete("/workflow-schedules/:id", async (req, res) => {
    assertBoard(req);
    const schedule = await scheduleSvc.get(req.params.id as string);
    if (!schedule) {
      res.status(404).json({ error: "Workflow schedule not found" });
      return;
    }
    const workflow = await svc.get(schedule.workflowId);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    await scheduleSvc.delete(schedule.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.schedule_deleted",
      entityType: "workflow_schedule",
      entityId: schedule.id,
      details: { workflowId: workflow.id, title: schedule.title },
    });
    res.status(204).end();
  });

  router.get("/workflow-runs/:id", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.post("/workflow-runs/:id/cancel", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    if (["succeeded", "failed", "cancelled", "rejected"].includes(detail.status)) {
      res.status(409).json({ error: "Workflow run is already in a terminal state" });
      return;
    }
    const actor = getActorInfo(req);
    const cancelled = await svc.cancelRun(detail.id, { userId: req.actor.userId ?? "board" });
    if (cancelled) {
      await logActivity(db, {
        companyId: detail.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "workflow.run_cancelled",
        entityType: "workflow_run",
        entityId: detail.id,
        details: { workflowId: detail.workflow.id },
      });
    }
    res.json(cancelled);
  });

  router.post("/workflow-runs/:id/extensions/citro-social-cms/v1/handoffs/:handoffId/feedback", validate(workflowRunFeedbackSchema), async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    const result = await svc.submitRunFeedback(detail.id, req.params.handoffId as string, req.body, { userId: req.actor.userId ?? "board" });
    if (!result) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    if (!result.duplicate) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: detail.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "workflow.run_feedback_submitted",
        entityType: "workflow_run",
        entityId: detail.id,
        details: { action: req.body.action, stage: req.body.stage, target: req.body.target, revision: result.revision },
      });
    }
    res.json({
      status: result.status,
      reviewState: req.body.action === "reject"
        ? "rejected"
        : req.body.action === "request_changes"
          ? "revision_requested"
          : "approved",
      reviewStage: result.reviewStage,
      revision: result.revision,
      duplicate: result.duplicate,
    });
  });

  router.get("/workflow-runs/:id/extensions/citro-social-cms/v1/events", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    res.json(await svc.listRunEvents(detail.id, after));
  });

  router.get("/workflow-runs/:id/extensions/citro-social-cms/v1/assets", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const assets = await svc.listRunAssets(detail.id);
    res.json({
      assets: assets.map((asset, index) => ({
        id: asset.id,
        deliverableId: asset.deliverableId,
        screenNumber: asset.screenNumber ?? index + 1,
        templateId: asset.templateId ?? "workflow-deliverable",
        postType: asset.postType ?? "single_image",
        status: asset.superseded ? "superseded" : "generated",
        url: new URL(asset.viewableUrl, baseUrl).toString(),
        thumbnailUrl: new URL(asset.thumbnailUrl ?? asset.viewableUrl, baseUrl).toString(),
      })),
    });
  });

  router.get("/workflow-runs/:id/extensions/citro-social-cms/v1/review", async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.id as string);
    if (!detail) return res.status(404).json({ error: "Workflow run not found" });
    assertCompanyAccess(req, detail.companyId);
    res.json(await svc.getRunReview(detail.id));
  });

  router.post("/workflow-handoffs/:id/approve", validate(resolveWorkflowHandoffSchema), async (req, res) => {
    assertBoard(req);
    const handoff = await svc.getHandoff(req.params.id as string);
    if (!handoff) {
      res.status(404).json({ error: "Workflow handoff not found" });
      return;
    }
    assertCompanyAccess(req, handoff.companyId);
    res.json(await svc.resolveHandoff(handoff.id, "approved", { userId: req.actor.userId ?? "board" }, req.body));
  });

  router.post("/workflow-handoffs/:id/reject", validate(resolveWorkflowHandoffSchema), async (req, res) => {
    assertBoard(req);
    const handoff = await svc.getHandoff(req.params.id as string);
    if (!handoff) {
      res.status(404).json({ error: "Workflow handoff not found" });
      return;
    }
    assertCompanyAccess(req, handoff.companyId);
    res.json(await svc.resolveHandoff(handoff.id, "rejected", { userId: req.actor.userId ?? "board" }, req.body));
  });

  router.post("/workflow-handoffs/:id/respond", validate(resolveWorkflowHandoffSchema), async (req, res) => {
    assertBoard(req);
    const handoff = await svc.getHandoff(req.params.id as string);
    if (!handoff) {
      res.status(404).json({ error: "Workflow handoff not found" });
      return;
    }
    assertCompanyAccess(req, handoff.companyId);
    res.json(await svc.resolveHandoff(handoff.id, "responded", { userId: req.actor.userId ?? "board" }, req.body));
  });

  router.post(
    "/workflow-runs/:id/runtime/phase-events",
    validate(runtimePhaseEventRequestSchema),
    async (req, res) => {
      const runId = req.params.id as string;
      const token = readRuntimeToken(req);
      const verified = await svc.verifyRuntimeToken(runId, token);
      if (!verified) {
        res.status(401).json({ error: "Invalid workflow runtime token" });
        return;
      }
      const { token: _token, ...event } = req.body as WorkflowPhaseEvent & { token: string };
      const updated = await svc.applyPhaseEvent(runId, event);
      if (!updated) {
        res.status(404).json({ error: `Workflow phase not found for key: ${event.phaseKey}` });
        return;
      }
      res.json(updated);
    },
  );

  router.post(
    "/workflow-runs/:id/runtime/telemetry-events",
    validate(runtimeTelemetryRequestSchema),
    async (req, res) => {
      const runId = req.params.id as string;
      const token = readRuntimeToken(req);
      const verified = await svc.verifyRuntimeToken(runId, token);
      if (!verified) {
        res.status(401).json({ error: "Invalid workflow runtime token" });
        return;
      }
      const { events } = req.body as WorkflowTelemetryBatch & { token: string };
      const result = await svc.applyTelemetryEvents(runId, events);
      if (!result) {
        res.status(404).json({ error: "Workflow run not found" });
        return;
      }
      res.status(202).json(result);
    },
  );

  router.post("/workflow-runs/:id/runtime/extensions/citro-social-cms/v1/review", validate(runtimeReviewRequestSchema), async (req, res) => {
    const runId = req.params.id as string;
    if (!await svc.verifyRuntimeToken(runId, readRuntimeToken(req))) return res.status(401).json({ error: "Invalid workflow runtime token" });
    const { token: _token, ...input } = req.body;
    const result = await svc.publishRunReview(runId, input);
    if (!result) return res.status(404).json({ error: "Workflow run not found" });
    res.status(201).json(result);
  });

  router.post("/workflow-runs/:id/runtime/extensions/citro-social-cms/v1/assets", validate(runtimeAssetsRequestSchema), async (req, res) => {
    const runId = req.params.id as string;
    if (!await svc.verifyRuntimeToken(runId, readRuntimeToken(req))) return res.status(401).json({ error: "Invalid workflow runtime token" });
    const { token: _token, ...input } = req.body;
    const result = await svc.publishRunAssets(runId, input);
    if (!result) return res.status(404).json({ error: "Workflow run not found" });
    res.status(201).json({ assets: result });
  });

  router.post("/workflow-runs/:id/handoffs/runtime", validate(runtimeCreateHandoffRequestSchema), async (req, res) => {
    const runId = req.params.id as string;
    const token = readRuntimeToken(req);
    const verified = await svc.verifyRuntimeToken(runId, token);
    if (!verified) {
      res.status(401).json({ error: "Invalid workflow runtime token" });
      return;
    }
    const { token: _token, ...input } = req.body as CreateWorkflowHandoff & { token: string };
    const handoff = await svc.createRuntimeHandoff(runId, input);

    // Attempt to open a ClickUp bridge for the handoff.
    // If ClickUp is not configured, return 503 immediately so the caller knows.
    try {
      const bridgeSvc = workflowHandoffBridgeService(db);
      await bridgeSvc.openForHandoff({
        id: handoff.id,
        companyId: handoff.companyId,
        workflowRunId: handoff.workflowRunId,
        kind: handoff.kind,
        promptMarkdown: handoff.promptMarkdown,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      res.status(status).json({ error: message, code });
      return;
    }

    res.status(201).json(handoff);
  });

  const getRuntimeHandoff = async (req: Request, res: Response) => {
    const handoff = await svc.getHandoff(req.params.id as string);
    if (!handoff) {
      res.status(404).json({ error: "Workflow handoff not found" });
      return;
    }
    const token = readRuntimeToken(req);
    const verified = await svc.verifyRuntimeToken(handoff.workflowRunId, token);
    if (!verified) {
      res.status(401).json({ error: "Invalid workflow runtime token" });
      return;
    }
    res.json(handoff);
  };

  router.post("/workflow-handoffs/:id/runtime", getRuntimeHandoff);

  return router;
}
