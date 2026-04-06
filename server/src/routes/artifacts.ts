import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { artifactService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function artifactRoutes(db: Db) {
  const router = Router();
  const svc = artifactService(db);

  router.get("/companies/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issueId = (req.query.issue_id as string) || undefined;
    const result = await svc.list(companyId, issueId);
    res.json(result);
  });

  router.post("/companies/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { title, kind, description, url, filePath, mimeType, sizeBytes, previewUrl, issueId, runId, metadata } = req.body;
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const artifact = await svc.create(companyId, {
      title,
      kind: kind ?? "attachment",
      description: description ?? null,
      url: url ?? null,
      filePath: filePath ?? null,
      mimeType: mimeType ?? null,
      sizeBytes: sizeBytes ?? null,
      previewUrl: previewUrl ?? null,
      issueId: issueId ?? null,
      runId: runId ?? null,
      metadata: metadata ?? {},
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.created",
      entityType: "artifact",
      entityId: artifact.id,
      details: { title: artifact.title, kind: artifact.kind },
    });

    res.status(201).json(artifact);
  });

  router.get("/companies/:companyId/artifacts/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const artifact = await svc.getById(id);
    if (!artifact || artifact.companyId !== companyId) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(artifact);
  });

  router.patch("/companies/:companyId/artifacts/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const { title, kind, description, url, filePath, mimeType, sizeBytes, previewUrl, status, metadata } = req.body;
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (kind !== undefined) patch.kind = kind;
    if (description !== undefined) patch.description = description;
    if (url !== undefined) patch.url = url;
    if (filePath !== undefined) patch.filePath = filePath;
    if (mimeType !== undefined) patch.mimeType = mimeType;
    if (sizeBytes !== undefined) patch.sizeBytes = sizeBytes;
    if (previewUrl !== undefined) patch.previewUrl = previewUrl;
    if (status !== undefined) patch.status = status;
    if (metadata !== undefined) patch.metadata = metadata;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const artifact = await svc.update(id, patch);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.updated",
      entityType: "artifact",
      entityId: artifact.id,
      details: { fields: Object.keys(patch) },
    });

    res.json(artifact);
  });

  router.delete("/companies/:companyId/artifacts/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const artifact = await svc.remove(id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "artifact.deleted",
      entityType: "artifact",
      entityId: artifact.id,
    });

    res.json(artifact);
  });

  return router;
}
