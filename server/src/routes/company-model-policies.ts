import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { modelPolicyRulesSchema } from "../services/model-policy-schema.js";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, companyModelPolicyService, logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const bodySchema = z.object({ rules: modelPolicyRulesSchema });

export function companyModelPolicyRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companyModelPolicyService(db);

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanMutateCompanyModelPolicies(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/companies/:companyId/model-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rules = await svc.getCompanyPolicy(companyId);
    res.json({ rules });
  });

  router.put(
    "/companies/:companyId/model-policies",
    validate(bodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanyModelPolicies(req, companyId);
      const rules = await svc.setCompanyPolicy(companyId, req.body.rules);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.model_policy_updated",
        entityType: "company_model_policy",
        entityId: companyId,
        details: {},
      });

      res.json({ rules });
    },
  );

  return router;
}
