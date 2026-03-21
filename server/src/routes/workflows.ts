import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { workflowService } from "../services/workflows.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function workflowRoutes(db: Db) {
  const router = Router();
  const svc = workflowService(db);

  // List workflows for a company
  router.get("/companies/:companyId/workflows", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workflows = await svc.list(companyId, {
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(workflows);
  });

  // Get a specific workflow with step details
  router.get("/workflows/:workflowId", async (req, res) => {
    assertBoard(req);
    const workflow = await svc.getById(req.params.workflowId as string);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    res.json(workflow);
  });

  // Create a new workflow
  router.post("/companies/:companyId/workflows", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { issueId, name, steps, onStepFailure, maxRetries, timeoutPerStepMs } = req.body;
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: "steps array is required and must be non-empty" });
      return;
    }

    const workflow = await svc.create(companyId, {
      issueId,
      name,
      steps,
      createdBy: req.actor.type === "board" ? (req.actor.userId ?? "board") : (req.actor.agentId ?? "agent"),
      onStepFailure,
      maxRetries,
      timeoutPerStepMs,
    });
    res.status(201).json(workflow);
  });

  // Start a workflow
  router.post("/workflows/:workflowId/start", async (req, res) => {
    assertBoard(req);
    const workflow = await svc.getById(req.params.workflowId as string);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    await svc.start(workflow.id);
    res.json({ ok: true, status: "running" });
  });

  // Advance a workflow step (called by heartbeat after step completion)
  router.post("/workflows/:workflowId/steps/:stepIndex/complete", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const stepIndex = parseInt(req.params.stepIndex as string, 10);
    const { status, result, error } = req.body;

    const advanceResult = await svc.advanceStep(workflowId, stepIndex, {
      status: status ?? "completed",
      result,
      error,
    });

    if (!advanceResult) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(advanceResult);
  });

  // Cancel a workflow
  router.post("/workflows/:workflowId/cancel", async (req, res) => {
    assertBoard(req);
    const workflow = await svc.getById(req.params.workflowId as string);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    assertCompanyAccess(req, workflow.companyId);
    await svc.cancel(workflow.id);
    res.json({ ok: true, status: "cancelled" });
  });

  return router;
}
