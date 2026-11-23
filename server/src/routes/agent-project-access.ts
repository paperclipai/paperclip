import type { Router } from "express";
import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { addAgentProjectAccessSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { addAgentProjectAccess, readAgentProjectAccess } from "../services/agent-project-access.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

export function registerAgentProjectAccessRoutes(router: Router, db: Db) {
  router.get("/agents/:id/project-access", async (req, res) => {
    assertBoard(req);
    const [agent] = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, req.params.id as string));
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    res.json(await readAgentProjectAccess(db, req.actor, agent.companyId, agent.id));
  });
  router.post("/agents/:id/project-access", validate(addAgentProjectAccessSchema), async (req, res) => {
    assertBoard(req);
    const [agent] = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, req.params.id as string));
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    res.json(await addAgentProjectAccess(db, req.actor, agent.companyId, agent.id, req.body.projectIds));
  });
}
