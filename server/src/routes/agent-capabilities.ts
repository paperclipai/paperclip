import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentCapabilityApplyPreviewRequestSchema,
  buildAgentCapabilityAuditSummary,
  updateAgentCapabilityConfigSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { agentCapabilityService } from "../services/agent-capabilities.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function assertBoardMutation(req: Parameters<typeof getActorInfo>[0]) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function agentCapabilityRoutes(db: Db) {
  const router = Router();
  const svc = agentCapabilityService(db);

  router.get("/companies/:companyId/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getCompanyDefaults(companyId));
  });

  router.patch(
    "/companies/:companyId/capabilities",
    validate(updateAgentCapabilityConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardMutation(req);

      const result = await svc.updateCompanyDefaults(companyId, req.body.config);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.agent_capabilities_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          scope: "company_default",
          ...buildAgentCapabilityAuditSummary(result.config),
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/capabilities/apply-preview",
    validate(agentCapabilityApplyPreviewRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // Dry-run/read-only preview — does not write, install, connect, execute,
      // apply, or materialize any capability. The endpoint computes a
      // sanitized proposal from persisted desired config plus the optional
      // submitted draft. No live MCP or external action is performed.
      const proposal = await svc.previewApplyForCompany(
        companyId,
        req.body.draftConfig,
        req.body.availableSecretNames,
      );
      res.json(proposal);
    },
  );

  router.get("/agents/:agentId/capabilities", async (req, res) => {
    const agentId = req.params.agentId as string;
    const result = await svc.getAgentCapabilities(agentId);
    assertCompanyAccess(req, result.companyId);
    res.json(result);
  });

  router.patch(
    "/agents/:agentId/capabilities",
    validate(updateAgentCapabilityConfigSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      assertBoardMutation(req);

      const current = await svc.getAgentCapabilities(agentId);
      assertCompanyAccess(req, current.companyId);
      const result = await svc.updateAgentCapabilities(agentId, req.body.config);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: result.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.capabilities_updated",
        entityType: "agent",
        entityId: agentId,
        details: {
          scope: "agent_local",
          ...buildAgentCapabilityAuditSummary(result.config),
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/agents/:agentId/capabilities/apply-preview",
    validate(agentCapabilityApplyPreviewRequestSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      // Resolve the agent's company so we can enforce assertCompanyAccess
      // before computing the (read-only) proposal.
      const current = await svc.getAgentCapabilities(agentId);
      assertCompanyAccess(req, current.companyId);
      const proposal = await svc.previewApplyForAgent(
        agentId,
        req.body.draftConfig,
        req.body.availableSecretNames,
      );
      res.json(proposal);
    },
  );

  return router;
}
