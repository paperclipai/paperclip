import { eq } from "drizzle-orm";
import { Router } from "express";
import { agents, departments, type Db } from "@paperclipai/db";
import {
  createDepartmentSchema,
  setAgentDepartmentsSchema,
  updateDepartmentSchema,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { departmentService } from "../services/departments.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function companyIdForDepartment(db: Db, id: string): Promise<string | null> {
  const [row] = await db
    .select({ companyId: departments.companyId })
    .from(departments)
    .where(eq(departments.id, id));
  return row?.companyId ?? null;
}

export function departmentRoutes(db: Db) {
  const router = Router();
  const svc = departmentService(db);

  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/departments", validate(createDepartmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { department, created } = await svc.create(companyId, req.body.name);
    if (created) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "department.created",
        entityType: "department",
        entityId: department.id,
        details: { name: department.name },
      });
    }
    res.status(created ? 201 : 200).json(department);
  });

  router.patch("/departments/:id", validate(updateDepartmentSchema), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID.test(id)) throw badRequest("Department ID must be a UUID");
    assertBoard(req);
    const companyId = await companyIdForDepartment(db, id);
    if (!companyId || !hasCompanyAccess(req, companyId)) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const department = await svc.rename(companyId, id, req.body.name);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "department.renamed",
      entityType: "department",
      entityId: department.id,
      details: { name: department.name },
    });
    res.json(department);
  });

  router.delete("/departments/:id", async (req, res) => {
    const id = req.params.id as string;
    if (!UUID.test(id)) throw badRequest("Department ID must be a UUID");
    assertBoard(req);
    const companyId = await companyIdForDepartment(db, id);
    if (!companyId || !hasCompanyAccess(req, companyId)) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const removed = await svc.remove(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "department.deleted",
      entityType: "department",
      entityId: removed.id,
      details: { name: removed.name },
    });
    res.json(removed);
  });

  router.put("/agents/:id/departments", validate(setAgentDepartmentsSchema), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID.test(id)) throw badRequest("Agent ID must be a UUID");
    assertBoard(req);
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id));
    if (!agent || !hasCompanyAccess(req, agent.companyId)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const memberships = await svc.setForAgent(agent.companyId, agent.id, req.body.departmentIds);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.departments_set",
      entityType: "agent",
      entityId: agent.id,
      details: { departmentIds: memberships.map((row) => row.id) },
    });
    res.json(memberships);
  });

  return router;
}
