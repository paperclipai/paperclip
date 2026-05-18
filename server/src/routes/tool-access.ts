import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentToolGrantBulkSetSchema,
  companyToolCreateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, logActivity, toolAccessService } from "../services/index.js";
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

  router.post("/companies/:companyId/tool-grants", validate(agentToolGrantBulkSetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManage(req, companyId);
    const actor = getActorInfo(req);
    const grantResults = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const txSvc = toolAccessService(txDb);
      const txAgents = agentService(txDb);
      const savedResults = [];
      for (const grant of req.body.grants) {
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
      return savedResults;
    });
    res.json({ grants: grantResults.map((result) => result.grant) });
  });

  return router;
}
