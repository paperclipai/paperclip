import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentToolGrantBulkSetSchema,
  companyToolCreateSchema,
  toolAccessPolicyUpdateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, approvalService, logActivity, toolAccessService } from "../services/index.js";
import { modeIncreases, riskMeetsThreshold } from "../services/tool-access.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function toolAccessRoutes(db: Db) {
  const router = Router();
  const svc = toolAccessService(db);
  const access = accessService(db);

  async function assertCanManage(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (await access.canUser(companyId, req.actor.userId, "agents:create")) return;
    }
    throw forbidden("Missing permission: agents:create");
  }

  router.get("/companies/:companyId/tools", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listMatrix(companyId));
  });

  router.post("/companies/:companyId/tools", validate(companyToolCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManage(req, companyId);
    const tool = await svc.createTool(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.tool_created",
      entityType: "company_tool",
      entityId: tool.id,
      details: { key: tool.key, label: tool.label, risk: tool.risk },
    });
    res.status(201).json(tool);
  });

  router.get("/companies/:companyId/tool-access-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getPolicy(companyId));
  });

  router.patch("/companies/:companyId/tool-access-policy", validate(toolAccessPolicyUpdateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManage(req, companyId);
    res.json(await svc.upsertPolicy(companyId, req.body));
  });

  router.post("/companies/:companyId/tool-grants", validate(agentToolGrantBulkSetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManage(req, companyId);
    const actor = getActorInfo(req);
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const txSvc = toolAccessService(txDb);
      const txAgents = agentService(txDb);
      const txApprovals = approvalService(txDb);
      const policy = await txSvc.getPolicy(companyId);
      const savedResults = [];
      const approvals = [];
      for (const grant of req.body.grants) {
        const preview = await txSvc.previewGrantChange(companyId, grant.agentId, grant.toolId, grant.mode);
        if (
          policy
          && grant.mode !== "off"
          && modeIncreases(preview.previousMode, grant.mode)
          && riskMeetsThreshold(preview.tool.risk, policy.approvalRequiredAtRisk)
        ) {
          const approval = await txApprovals.create(companyId, {
            type: "tool_access_change",
            status: "pending",
            requestedByAgentId: actor.agentId,
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            payload: {
              agentId: grant.agentId,
              toolId: grant.toolId,
              mode: grant.mode,
            },
          });
          approvals.push(approval);
          continue;
        }
        const saved = await txSvc.setGrant(
          companyId,
          grant.agentId,
          grant.toolId,
          grant.mode,
          actor.actorType === "user" ? actor.actorId : null,
        );
        savedResults.push(saved);
      }
      const matrix = await txSvc.listMatrix(companyId);
      const affectedAgentIds = new Set(savedResults.map((result) => result.grant.agentId));
      for (const agentId of affectedAgentIds) {
        const agent = await txAgents.getById(agentId);
        if (!agent || agent.companyId !== companyId || agent.adapterType !== "hermes_local") continue;
        const rendered = await txSvc.renderHermesAgentConfig(companyId, agent, matrix);
        await txAgents.update(
          agent.id,
          {
            adapterConfig: rendered.adapterConfig,
            metadata: rendered.metadata,
          },
          {
            recordRevision: {
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              source: "tool_access_policy_render",
            },
          },
        );
      }
      for (const result of savedResults) {
        await logActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "company.tool_grant_changed",
          entityType: "company_tool",
          entityId: result.tool.id,
          details: {
            agentId: result.grant.agentId,
            toolLabel: result.tool.label,
            previousMode: result.previousMode,
            newMode: result.grant.mode,
            risk: result.tool.risk,
          },
        });
      }
      return { savedResults, approvals };
    });
    res.json({ grants: result.savedResults.map((entry) => entry.grant), approvals: result.approvals });
  });

  return router;
}
