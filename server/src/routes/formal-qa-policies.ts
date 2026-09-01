import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertFormalQaPolicySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { formalQaPolicyService } from "../services/formal-qa-policies.js";
import { assertCompanyAccess, assertInstanceAdmin, getAccessibleResource, getActorInfo } from "./authz.js";
import { projectService } from "../services/projects.js";

/** Instance-admin only: policy changes alter the Formal-QA trust root. */
export function formalQaPolicyRoutes(db: Db) {
  const router = Router();
  const projects = projectService(db);
  const policies = formalQaPolicyService(db);
  router.get("/projects/:id/formal-qa-policy", async (req, res) => {
    assertInstanceAdmin(req);
    const project = await getAccessibleResource(req, res, projects.getById(req.params.id as string), "Project not found");
    if (!project) return;
    assertCompanyAccess(req, project.companyId);
    res.json(await policies.getForProject(project.companyId, project.id));
  });
  router.put("/projects/:id/formal-qa-policy", validate(upsertFormalQaPolicySchema), async (req, res) => {
    assertInstanceAdmin(req);
    const project = await getAccessibleResource(req, res, projects.getById(req.params.id as string), "Project not found");
    if (!project) return;
    assertCompanyAccess(req, project.companyId);
    const actor = getActorInfo(req);
    const result = await policies.upsert({ ...req.body, companyId: project.companyId, projectId: project.id, actorUserId: actor.actorId });
    await logActivity(db, { companyId: project.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "formal_qa.policy_updated", entityType: "formal_qa_policy", entityId: result.policy.id, details: { projectId: project.id, workspaceId: result.policy.projectWorkspaceId, policyVersion: result.policy.version, enabled: result.policy.enabled } });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
