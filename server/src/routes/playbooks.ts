import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { assertCanWrite, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { playbookService } from "../services/playbooks.js";
import { playbookExecutionService } from "../services/playbook-execution.js";

export function playbookRoutes(db: Db) {
  const router = Router();
  const svc = playbookService(db);
  const execSvc = playbookExecutionService(db);

  /** List all playbooks for a company. */
  router.get("/companies/:companyId/playbooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const list = await svc.list(companyId);
    res.json(list);
  });

  /** Get a single playbook with steps. */
  router.get("/companies/:companyId/playbooks/:playbookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getWithSteps(req.params.playbookId as string);
    if (!result || result.companyId !== companyId) {
      throw notFound("Playbook not found");
    }
    res.json(result);
  });

  /** Create a new playbook. */
  router.post("/companies/:companyId/playbooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const { name, description, body, icon, category, estimatedMinutes, steps } = req.body;
    if (!name) throw badRequest("name is required");

    const playbook = await svc.create({
      companyId,
      name,
      description,
      body,
      icon,
      category,
      estimatedMinutes,
      steps,
    });

    res.status(201).json(playbook);
  });

  /** Update a playbook. */
  router.patch("/companies/:companyId/playbooks/:playbookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const existing = await svc.getById(req.params.playbookId as string);
    if (!existing || existing.companyId !== companyId) {
      throw notFound("Playbook not found");
    }

    const updated = await svc.update(existing.id, req.body);
    res.json(updated);
  });

  /** Delete a playbook. */
  router.delete("/companies/:companyId/playbooks/:playbookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const existing = await svc.getById(req.params.playbookId as string);
    if (!existing || existing.companyId !== companyId) {
      throw notFound("Playbook not found");
    }

    await svc.deletePlaybook(existing.id);
    res.status(204).end();
  });

  /** Seed default playbooks for a company. */
  router.post("/companies/:companyId/playbooks/seed", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);
    const result = await svc.seedDefaults(companyId);
    res.json(result);
  });

  /** Run a playbook — creates goal, issues, and tracks execution. */
  router.post("/companies/:companyId/playbooks/:playbookId/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);
    const actor = getActorInfo(req);

    const result = await execSvc.runPlaybook({
      companyId,
      playbookId: req.params.playbookId as string,
      triggeredBy: actor.actorId,
      projectId: (req.body as { projectId?: string }).projectId ?? null,
    });

    res.status(201).json(result);
  });

  /** Get a playbook run with step statuses. */
  router.get("/companies/:companyId/playbook-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const result = await execSvc.getRunWithSteps(req.params.runId as string);
    if (!result || result.companyId !== companyId) {
      throw notFound("Playbook run not found");
    }
    res.json(result);
  });

  /** List runs for a company (optionally filtered by playbook). */
  router.get("/companies/:companyId/playbook-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const playbookId = req.query.playbookId as string | undefined;
    const runs = await execSvc.listRuns(companyId, playbookId);
    res.json(runs);
  });

  /** Notify that an issue was completed — triggers dependency resolution. */
  router.post("/companies/:companyId/playbook-runs/issue-completed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { issueId } = req.body as { issueId: string };
    if (!issueId) throw badRequest("issueId is required");

    const result = await execSvc.onIssueCompleted(issueId);
    res.json(result ?? { unblocked: 0, runComplete: false });
  });

  return router;
}
