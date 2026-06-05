import { type Request, type Response, Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  type CreateWorkflowHandoff,
  type WorkflowPhaseEvent,
  createWorkflowHandoffSchema,
  createWorkflowSchema,
  resolveWorkflowHandoffSchema,
  runWorkflowSchema,
  updateWorkflowSchema,
  workflowPhaseEventSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { logActivity, workflowHandoffBridgeService, workflowService } from "../services/index.js";
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
  const runtimePhaseEventRequestSchema = workflowPhaseEventSchema.extend({
    token: z.string().trim().min(1),
  });
  const runtimeCreateHandoffRequestSchema = createWorkflowHandoffSchema.extend({
    token: z.string().trim().min(1),
  });

  router.get("/companies/:companyId/workflows", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
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
    const updated = await svc.update(existing.id, req.body, { userId: req.actor.userId ?? "board" });
    if (!updated) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: existing.id,
      details: { title: updated.title },
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
