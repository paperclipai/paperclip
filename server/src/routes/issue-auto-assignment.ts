import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { Router, type Request } from "express";
import { autoAssignIssueSchema } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { agentAssignmentService } from "../services/agent-assignment.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function issueAutoAssignmentRoutes(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  const router = Router();
  const assignment = agentAssignmentService(db, { wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts) });

  async function task(req: Request) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, req.params.id as string), await issueReadSqlCondition(db, req.actor)));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Task not found");
    assertCompanyAccess(req, issue.companyId);
    const decision = await accessService(db).decide({ actor: req.actor, action: "issue:mutate", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    } });
    if (!decision.allowed) throw forbidden("This task is outside this actor's authorization boundary");
    return issue;
  }

  /** Chooses an agent for an unassigned task and assigns it. Each candidate passes the caller's own tasks:assign check. */
  router.post("/issues/:id/auto-assign", validate(autoAssignIssueSchema), async (req, res) => {
    const issue = await task(req);
    const actorInfo = getActorInfo(req);
    const userId = actorInfo.actorType === "user" ? actorInfo.actorId : issue.responsibleUserId ?? null;
    const assignmentRouting = await assignment.autoAssign({
      issueId: issue.id, actor: req.actor, userId, request: autoAssignIssueSchema.parse(req.body ?? {}),
      activityActor: { actorType: actorInfo.actorType, actorId: actorInfo.actorId, agentId: actorInfo.agentId, runId: actorInfo.runId },
    });
    res.json({ assignmentRouting });
  });

  router.get("/issues/:id/assignment-routing", async (req, res) => {
    const issue = await task(req);
    res.json({ assignmentRouting: issue.assignmentRouting ?? null });
  });

  return router;
}
