import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ingestMemorySchema, searchMemorySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { memoryService } from "../services/index.js";
import { notFound } from "../errors.js";

function parseTagsQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  router.post("/companies/:companyId/memory", validate(ingestMemorySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const entry = await svc.ingest(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    });
    res.status(201).json(entry);
  });

  router.get("/companies/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : undefined;

    const result = await svc.browse({
      companyId,
      projectId: (req.query.projectId as string | undefined) ?? null,
      goalId: (req.query.goalId as string | undefined) ?? null,
      key: req.query.key as string | undefined,
      tags: parseTagsQuery(req.query.tags),
      limit: limitRaw,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = searchMemorySchema.parse({
      query: req.query.query as string | undefined,
      projectId: (req.query.projectId as string | undefined) ?? null,
      goalId: (req.query.goalId as string | undefined) ?? null,
      key: req.query.key as string | undefined,
      tags: parseTagsQuery(req.query.tags),
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    });

    const result = await svc.search(companyId, parsed);
    res.json(result);
  });

  router.get("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const entry = await svc.get(companyId, id);
    if (!entry) throw notFound("Memory entry not found");
    res.json(entry);
  });

  router.delete("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const id = req.params.id as string;
    const existing = await svc.get(companyId, id);
    if (!existing) throw notFound("Memory entry not found");
    await svc.forget(companyId, id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    });
    res.status(204).end();
  });

  return router;
}
