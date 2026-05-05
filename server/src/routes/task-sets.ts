import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { taskSets } from "@paperclipai/db";
import { createTaskSetService } from "../services/task-sets.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

export function taskSetRoutes(db: Db) {
  const router = Router();
  const svc = createTaskSetService(db);

  async function resolveTaskSetCompanyId(id: string): Promise<string | null> {
    const row = await db.select({ companyId: taskSets.companyId }).from(taskSets).where(eq(taskSets.id, id)).then((r) => r[0] ?? null);
    return row?.companyId ?? null;
  }

  // Company-scoped endpoints
  router.post("/companies/:companyId/task-sets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { title, description, info, templateId } = req.body;
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const actor = getActorInfo(req);
    const created = await svc.create(companyId, {
      title,
      description: description ?? null,
      info: info ?? null,
      templateId: templateId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/task-sets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const isTemplate =
      req.query.isTemplate === "true" ? true
      : req.query.isTemplate === "false" ? false
      : undefined;
    const result = await svc.list(companyId, { isTemplate });
    res.json(result);
  });

  // Set-scoped endpoints
  router.get("/task-sets/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveTaskSetCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const result = await svc.getById(companyId, id);
    res.json(result);
  });

  router.patch("/task-sets/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveTaskSetCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const { title, description, info } = req.body;
    const updated = await svc.update(companyId, id, { title, description, info });
    res.json(updated);
  });

  router.delete("/task-sets/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveTaskSetCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    await svc.delete(companyId, id);
    res.status(204).send();
  });

  // Members
  router.post("/task-sets/:id/members", async (req, res) => {
    const taskSetId = req.params.id as string;
    const companyId = await resolveTaskSetCompanyId(taskSetId);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const { issueId, sortOrder } = req.body;
    if (!issueId) {
      res.status(400).json({ error: "issueId is required" });
      return;
    }
    const member = await svc.addMember(companyId, taskSetId, issueId, sortOrder ?? 0);
    res.status(201).json(member);
  });

  router.delete("/task-sets/:id/members/:issueId", async (req, res) => {
    const taskSetId = req.params.id as string;
    const issueId = req.params.issueId as string;
    const companyId = await resolveTaskSetCompanyId(taskSetId);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    await svc.removeMember(companyId, taskSetId, issueId);
    res.status(204).send();
  });

  // Template initiation
  router.post("/task-sets/:templateId/initiate", async (req, res) => {
    const templateId = req.params.templateId as string;
    const companyId = await resolveTaskSetCompanyId(templateId);
    if (!companyId) {
      res.status(404).json({ error: "Task set not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const { assigneeUserId, assigneeAgentId, attachedRecordKind, attachedRecordId } = req.body;
    if (!attachedRecordKind || !attachedRecordId) {
      res.status(400).json({ error: "attachedRecordKind and attachedRecordId are required" });
      return;
    }
    const actor = getActorInfo(req);
    const liveSet = await svc.initiate(companyId, templateId, {
      assigneeUserId: assigneeUserId ?? null,
      assigneeAgentId: assigneeAgentId ?? null,
      attachedRecordKind,
      attachedRecordId,
      initiatorAgentId: actor.agentId ?? null,
      initiatorUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.status(201).json(liveSet);
  });

  return router;
}
