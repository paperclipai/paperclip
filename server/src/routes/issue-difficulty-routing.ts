import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { Router, type Request } from "express";
import { difficultyTierSchema, readDifficultyRoutingConfig, setIssueDifficultyTierSchema, type IssueDifficultyRouting } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { logActivity } from "../services/activity-log.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function issueDifficultyRoutingRoutes(db: Db) {
  const router = Router();
  async function task(req: Request) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, req.params.id as string), await issueReadSqlCondition(db, req.actor)));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Task not found");
    assertCompanyAccess(req, issue.companyId);
    const decision = await accessService(db).decide({ actor: req.actor, action: "issue:mutate", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    } });
    if (!decision.allowed) throw forbidden("Task difficulty is outside this actor's authorization boundary");
    return issue;
  }
  router.put("/issues/:id/difficulty-routing", validate(setIssueDifficultyTierSchema), async (req, res) => {
    const issue = await task(req);
    const tier = difficultyTierSchema.parse(req.body.tier);
    const [assignee] = issue.assigneeAgentId ? await db.select({ id: agents.id, runtimeConfig: agents.runtimeConfig }).from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId))) : [];
    const setting = readDifficultyRoutingConfig(assignee?.runtimeConfig ?? null)?.tiers[tier];
    const difficultyRouting: IssueDifficultyRouting = {
      tier, source: "manual", agentId: assignee?.id ?? null, model: setting?.model ?? null, effort: setting?.effort ?? null,
      confidence: null, decidedAt: new Date().toISOString(), decisionInvocationId: null,
    };
    await db.update(issues).set({ difficultyRouting, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    await logActivity(db, { companyId: issue.companyId, ...getActorInfo(req), action: "issue.difficulty_routing.set", entityType: "issue", entityId: issue.id,
      details: { tier, previousTier: (issue.difficultyRouting as { tier?: string } | null)?.tier ?? null, applies: "next_run" } });
    res.json({ difficultyRouting });
  });
  router.delete("/issues/:id/difficulty-routing", async (req, res) => {
    const issue = await task(req);
    await db.update(issues).set({ difficultyRouting: null, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    await logActivity(db, { companyId: issue.companyId, ...getActorInfo(req), action: "issue.difficulty_routing.reset", entityType: "issue", entityId: issue.id,
      details: { previousTier: (issue.difficultyRouting as { tier?: string } | null)?.tier ?? null, applies: "next_run" } });
    res.json({ difficultyRouting: null });
  });
  return router;
}
