import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { builtInAgentProvisionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { accessService, logActivity } from "../services/index.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function builtInAgentRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = builtInAgentService(db);

  async function assertCanProvisionBuiltInAgents(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function logBuiltInAgentMutation(
    req: Request,
    input: {
      companyId: string;
      action: "built_in_agent.provision_requested" | "built_in_agent.reset" | "approval.created";
      key: string;
      agentId: string | null;
      status: string;
      approvalId?: string | null;
    },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: input.action,
      entityType: input.action === "approval.created" ? "approval" : "agent",
      entityId: input.action === "approval.created" ? input.approvalId ?? input.key : input.agentId ?? input.key,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
      details: {
        key: input.key,
        status: input.status,
        approvalId: input.approvalId ?? null,
      },
    });
  }

  router.get("/companies/:companyId/built-in-agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post(
    "/companies/:companyId/built-in-agents/:key/provision",
    validate(builtInAgentProvisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;
      await assertCanProvisionBuiltInAgents(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.provision(companyId, key, req.body, {
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      const { state, approval } = result;
      await logBuiltInAgentMutation(req, {
        companyId,
        action: "built_in_agent.provision_requested",
        key,
        agentId: state.agentId,
        status: state.status,
      });
      if (approval) {
        await logBuiltInAgentMutation(req, {
          companyId,
          action: "approval.created",
          key,
          agentId: state.agentId,
          status: approval.status,
          approvalId: approval.id,
        });
      }
      res.status(approval ? 202 : 200).json({ ...state, approval });
    },
  );

  router.post("/companies/:companyId/built-in-agents/:key/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    await assertCanProvisionBuiltInAgents(req, companyId);
    const state = await svc.reset(companyId, key);
    await logBuiltInAgentMutation(req, {
      companyId,
      action: "built_in_agent.reset",
      key,
      agentId: state.agentId,
      status: state.status,
    });
    res.json(state);
  });

  return router;
}
