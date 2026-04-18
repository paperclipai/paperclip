import { Router } from "express";
import { z } from "zod";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { issueService, projectService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { scopedCompanyAuthz } from "./scoped-company-authz.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional(),
  actorId: z.string().min(1).optional(),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);
  const projectsSvc = projectService(db);
  const scopedAuthz = scopedCompanyAuthz(db);

  const activityReadPermissionKeys = [
    "issues:view",
    "projects:view",
    "agents:view",
    "departments:view",
    "teams:view",
  ] as const;

  const activityManagePermissionKeys = [
    "issues:manage",
    "projects:manage",
    "agents:manage",
  ] as const;

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  async function resolveIssueDepartmentId(issue: {
    companyId: string;
    departmentId?: string | null;
    projectId?: string | null;
  }) {
    if (issue.departmentId !== undefined && issue.departmentId !== null) {
      return issue.departmentId ?? null;
    }
    if (!issue.projectId) return null;
    const project = await projectsSvc.getById(issue.projectId);
    if (!project || project.companyId !== issue.companyId) return null;
    return project.departmentId ?? null;
  }

  function stripScopedDepartment<T extends { departmentId?: string | null }>(row: T) {
    const { departmentId: _departmentId, ...rest } = row;
    return rest;
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, activityReadPermissionKeys);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      scopeDepartmentIds: scope.companyWide ? undefined : scope.departmentIds,
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertInstanceAdmin(req);
    const companyId = req.params.companyId as string;
    await scopedAuthz.assertAnyScopedPermission(req, companyId, activityManagePermissionKeys, null);
    const actor = getActorInfo(req);
    const event = await svc.create({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: req.body.action,
      entityType: req.body.entityType,
      entityId: req.body.entityId,
      agentId: req.body.agentId ?? null,
      runId: actor.runId,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const departmentId = await resolveIssueDepartmentId(issue);
    await scopedAuthz.assertAnyScopedPermission(req, issue.companyId, activityReadPermissionKeys, departmentId);
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const departmentId = await resolveIssueDepartmentId(issue);
    await scopedAuthz.assertAnyScopedPermission(req, issue.companyId, activityReadPermissionKeys, departmentId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await db
      .select({ companyId: heartbeatRuns.companyId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) {
      res.json([]);
      return;
    }
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, run.companyId, activityReadPermissionKeys);
    const result = await svc.issuesForRun(runId);
    const filtered = scope.companyWide
      ? result
      : result.filter((issue) => issue.departmentId && scope.departmentIds.includes(issue.departmentId));
    res.json(filtered.map(stripScopedDepartment));
  });

  return router;
}
