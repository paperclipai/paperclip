import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createWorkflowSchema,
  updateWorkflowSchema,
  assignWorkflowSchema,
  createWorkflowRunSchema,
  submitWorkflowStepSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { workflowService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function workflowRoutes(db: Db) {
  const router = Router();
  const svc = workflowService(db);

  /* ================================================================ */
  /*  Definition CRUD                                                  */
  /* ================================================================ */

  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/workflows", validate(createWorkflowSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const workflow = await svc.create(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow.created",
      entityType: "workflow",
      entityId: workflow.id,
      details: { name: workflow.name, slug: workflow.slug },
    });
    res.status(201).json(workflow);
  });

  router.get("/workflows/:id", async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/workflows/:id", validate(updateWorkflowSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getDetail(id);
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const workflow = await svc.update(id, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      details: req.body,
    });
    res.json(workflow);
  });

  router.delete("/workflows/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getDetail(id);
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const workflow = await svc.archive(id, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow.archived",
      entityType: "workflow",
      entityId: id,
    });
    res.json(workflow);
  });

  router.get("/workflows/:id/revisions", async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const revisions = await svc.listRevisions(id);
    res.json(revisions);
  });

  router.get("/workflows/:id/mermaid", async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const result = await svc.generateMermaid(id);
    res.json(result);
  });

  /* ================================================================ */
  /*  Assignments                                                      */
  /* ================================================================ */

  router.get("/workflows/:id/assignments", async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const assignments = await svc.listAssignments(id);
    res.json(assignments);
  });

  router.post("/workflows/:id/assignments", validate(assignWorkflowSchema), async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const actor = getActorInfo(req);
    const assignment = await svc.assign(id, req.body.agentId, detail.companyId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: detail.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow.agent_assigned",
      entityType: "workflow",
      entityId: id,
      details: { agentId: req.body.agentId },
    });
    res.status(201).json(assignment);
  });

  router.delete("/workflow-assignments/:id", async (req, res) => {
    const id = req.params.id as string;
    const assignment = await svc.unassign(id);
    res.json(assignment);
  });

  router.get("/agents/:agentId/workflows", async (req, res) => {
    const agentId = req.params.agentId as string;
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId query parameter required" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const workflows = await svc.listAgentWorkflows(companyId, agentId);
    res.json(workflows);
  });

  /* ================================================================ */
  /*  Runtime: Runs + Steps                                            */
  /* ================================================================ */

  router.post("/workflows/:id/runs", validate(createWorkflowRunSchema), async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const actor = getActorInfo(req);
    const run = await svc.createRun(detail.companyId, { ...req.body, workflowId: id }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: detail.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow_run.created",
      entityType: "workflow_run",
      entityId: run.id,
      details: { workflowId: id },
    });
    res.status(201).json(run);
  });

  router.get("/workflows/:id/runs", async (req, res) => {
    const id = req.params.id as string;
    const detail = await svc.getDetail(id);
    assertCompanyAccess(req, detail.companyId);
    const runs = await svc.listRuns(id);
    res.json(runs);
  });

  router.get("/workflow-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const status = await svc.getRunStatus(runId);
    assertCompanyAccess(req, status.companyId);
    res.json(status);
  });

  router.get("/workflow-runs/:runId/current-step", async (req, res) => {
    const runId = req.params.runId as string;
    const status = await svc.getRunStatus(runId);
    assertCompanyAccess(req, status.companyId);
    const step = await svc.getCurrentStep(runId);
    res.json(step);
  });

  router.post("/workflow-runs/:runId/submit", validate(submitWorkflowStepSchema), async (req, res) => {
    const runId = req.params.runId as string;
    const existingRun = await svc.getRunStatus(runId);
    assertCompanyAccess(req, existingRun.companyId);
    const run = await svc.submitStep(runId, req.body);
    res.json(run);
  });

  router.post("/workflow-runs/:runId/cancel", async (req, res) => {
    const runId = req.params.runId as string;
    const existingRun = await svc.getRunStatus(runId);
    assertCompanyAccess(req, existingRun.companyId);
    const reason = (req.body as Record<string, unknown>).reason as string | undefined;
    const run = await svc.cancelRun(runId, reason);
    res.json(run);
  });

  router.get("/workflow-runs/:runId/steps", async (req, res) => {
    const runId = req.params.runId as string;
    const existingRun = await svc.getRunStatus(runId);
    assertCompanyAccess(req, existingRun.companyId);
    const steps = await svc.listRunSteps(runId);
    res.json(steps);
  });

  router.get("/workflow-runs/:runId/mermaid", async (req, res) => {
    const runId = req.params.runId as string;
    const existingRun = await svc.getRunStatus(runId);
    assertCompanyAccess(req, existingRun.companyId);
    const result = await svc.generateRunMermaid(runId);
    res.json(result);
  });

  return router;
}
