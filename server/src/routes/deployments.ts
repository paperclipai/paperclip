import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { deploymentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function deploymentRoutes(db: Db) {
  const router = Router();
  const svc = deploymentService(db);

  router.get("/companies/:companyId/deployments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/deployments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { projectId, agentId, runId, environment, url, provider, metadata } = req.body;

    const deployment = await svc.create(companyId, {
      projectId: projectId ?? null,
      agentId: agentId ?? null,
      runId: runId ?? null,
      environment: environment ?? "staging",
      url: url ?? null,
      provider: provider ?? null,
      metadata: metadata ?? {},
      startedAt: new Date(),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deployment.created",
      entityType: "deployment",
      entityId: deployment.id,
      details: { environment: deployment.environment, provider: deployment.provider },
    });

    res.status(201).json(deployment);
  });

  router.patch("/companies/:companyId/deployments/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Deployment not found" });
      return;
    }

    const { status, url, deployLog, finishedAt, metadata } = req.body;
    const updateData: Record<string, unknown> = {};
    if (status !== undefined) updateData.status = status;
    if (url !== undefined) updateData.url = url;
    if (deployLog !== undefined) updateData.deployLog = deployLog;
    if (metadata !== undefined) updateData.metadata = metadata;
    if (finishedAt !== undefined) {
      updateData.finishedAt = new Date(finishedAt);
    } else if (status === "succeeded" || status === "failed") {
      updateData.finishedAt = new Date();
    }

    const deployment = await svc.update(id, updateData);
    if (!deployment) {
      res.status(404).json({ error: "Deployment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deployment.updated",
      entityType: "deployment",
      entityId: deployment.id,
      details: { status: deployment.status },
    });

    res.json(deployment);
  });

  return router;
}
