import { eq } from "drizzle-orm";
import { Router } from "express";
import { agents, departments, type Db } from "@paperclipai/db";
import {
  createDepartmentSchema,
  setAgentDepartmentsSchema,
  updateDepartmentSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
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

export function departmentRoutes(db: Db) {
  const router = Router();
  const svc = departmentService(db);
  const access = authorizationService(db);

  // The agent card writes a department the same way it writes the rest of
  // Identity. Board keeps the access it already had. An agent can write a
  // card it is allowed to update, including its own. Rename and delete stay
  // board-only: they change the company-wide label and have no card control.
  async function assertCanEditAgentDepartments(req: Parameters<typeof assertCompanyAccess>[0], companyId: string, agentId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/departments", validate(createDepartmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      const agentId = req.actor.agentId;
      if (!agentId) throw forbidden("Board or agent access required");
      await assertCanEditAgentDepartments(req, companyId, agentId);
    }
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
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id));
    if (!agent || !hasCompanyAccess(req, agent.companyId)) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanEditAgentDepartments(req, agent.companyId, agent.id);
    const ids = [...req.body.departmentIds];
    for (const name of req.body.names ?? []) {
      const { department, created } = await svc.create(agent.companyId, name);
      ids.push(department.id);
      if (!created) continue;
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: agent.companyId,
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
    const memberships = await svc.setForAgent(agent.companyId, agent.id, ids);
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
