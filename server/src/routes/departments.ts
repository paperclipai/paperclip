import { eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { agents, departments, type Db } from "@paperclipai/db";
import {
  createDepartmentSchema,
  setAgentDepartmentsSchema,
  updateDepartmentSchema,
  type Department,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { authorizationDeniedDetails, authorizationService } from "../services/authorization.js";
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

async function presentDepartments(db: Db, req: Request, companyId: string, rows: Department[]): Promise<Department[]> {
  const agentIds = [...new Set(rows.flatMap((row) => row.agentIds))];
  if (agentIds.length === 0) return rows;
  const decisions = await authorizationService(db).decideMany(agentIds.map((agentId) => ({
    actor: req.actor,
    action: "agent:read",
    resource: { type: "agent" as const, companyId, agentId },
  })));
  const allowed = new Set(agentIds.filter((_, index) => decisions[index]?.allowed));
  return rows.map((row) => ({
    ...row,
    agentIds: row.agentIds.filter((agentId) => allowed.has(agentId)),
  }));
}

async function presentDepartment(db: Db, req: Request, companyId: string, row: Department): Promise<Department> {
  const [presented] = await presentDepartments(db, req, companyId, [row]);
  return presented ?? row;
}

export function departmentRoutes(db: Db) {
  const router = Router();
  const svc = departmentService(db);

  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await presentDepartments(db, req, companyId, await svc.list(companyId)));
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
    res.status(created ? 201 : 200).json(await presentDepartment(db, req, companyId, department));
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
    res.json(await presentDepartment(db, req, companyId, department));
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
    res.json(await presentDepartment(db, req, companyId, removed));
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
    const decision = await accessService(db).decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
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
    res.json(await presentDepartments(db, req, agent.companyId, memberships));
  });

  return router;
}
