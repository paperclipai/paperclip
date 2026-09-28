import { Router } from "express";
import { agents, executionGrantPolicies, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertActiveExecutionGrantRun, issueExecutionGrant } from "../services/execution-grants.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const policySchema = z.object({ stewardAgentId: z.string().guid() });
const issueGrantSchema = z.object({
  decisionKind: z.enum(["agent", "board"]),
  decisionId: z.string().guid(),
});

export function executionGrantRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/execution-grant-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await db.select().from(executionGrantPolicies)
      .where(eq(executionGrantPolicies.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Execution grant policy not found");
    res.json(policy);
  });

  router.put("/companies/:companyId/execution-grant-policy", validate(policySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const steward = await db.select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, req.body.stewardAgentId)))
      .then((rows) => rows[0] ?? null);
    if (!steward || steward.status === "terminated") throw notFound("Active steward agent not found");

    const actor = getActorInfo(req);
    const [policy] = await db.insert(executionGrantPolicies).values({
      companyId,
      stewardAgentId: steward.id,
      updatedByUserId: actor.actorId,
    }).onConflictDoUpdate({
      target: executionGrantPolicies.companyId,
      set: {
        stewardAgentId: steward.id,
        version: sql`${executionGrantPolicies.version} + 1`,
        updatedByUserId: actor.actorId,
        updatedAt: new Date(),
      },
    }).returning();
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "execution_grant.policy_updated",
      entityType: "company",
      entityId: companyId,
      details: { stewardAgentId: policy.stewardAgentId, version: policy.version },
    });
    res.json(policy);
  });

  router.post("/issues/:id/execution-grants", validate(issueGrantSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) {
      throw forbidden("A named executor run is required", { code: "execution_grant_executor_required" });
    }
    const companyId = req.actor.companyId;
    if (!companyId) throw forbidden("Company-scoped agent authentication is required");
    assertCompanyAccess(req, companyId);
    const executorAgentId = req.actor.agentId;
    const runId = req.actor.runId;
    const actor = getActorInfo(req);
    const grant = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await assertActiveExecutionGrantRun({
        db: txDb,
        companyId,
        executorAgentId,
        runId,
      });
      const issued = await issueExecutionGrant({
        db: txDb,
        companyId,
        issueId: req.params.id as string,
        decisionKind: req.body.decisionKind,
        decisionId: req.body.decisionId,
        executorAgentId,
      });
      if (issued?.newlyIssued) {
        await logActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "execution_grant.issued",
          entityType: "execution_grant",
          entityId: issued.id,
          issueId: req.params.id as string,
          details: {
            decisionKind: issued.decisionKind,
            decisionId: issued.decisionId,
            executorAgentId: issued.executorAgentId,
            targetAgentId: issued.targetAgentId,
            operation: issued.operation,
            policyVersion: issued.policyVersion,
          },
        });
      }
      return issued;
    });
    if (!grant) throw forbidden("Execution grant could not be issued");
    const { newlyIssued, ...grantRow } = grant;
    res.status(newlyIssued ? 201 : 200).json(grantRow);
  });

  return router;
}
