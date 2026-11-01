import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { updatePromptInjectionPreventionSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { promptInjectionPreventionService } from "../services/prompt-injection-prevention.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { listOpenRouterModels } from "../services/openrouter-models.js";

export function promptInjectionPreventionRoutes(db: Db) {
  const router = Router();
  const service = promptInjectionPreventionService(db, { budgetHooks: { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork } });
  router.get("/companies/:companyId/prompt-injection-prevention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    res.json(canManage ? { canManage, settings: await service.settings(companyId), choices: await service.choices(companyId, getActorInfo(req).actorId) }
      : { canManage, settings: null, choices: [] });
  });
  router.put("/companies/:companyId/prompt-injection-prevention", validate(updatePromptInjectionPreventionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(await service.configure(companyId, getActorInfo(req).actorId, req.body));
  });
  router.get("/companies/:companyId/prompt-injection-prevention/models", async (req, res) => {
    const companyId = req.params.companyId as string, userId = getActorInfo(req).actorId;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    const choice = (await service.choices(companyId, userId)).find(c => c.id === req.query.connectionId);
    if (!choice) throw forbidden();
    await aiConnectionService(db).selectPromptInjectionPrevention({ companyId, userId, connectionId: choice.id, grantId: choice.grantId });
    res.json((await listOpenRouterModels()).map(m => ({ ...m, id: m.id.replace(/^openrouter\//, "") })));
  });
  router.post("/companies/:companyId/prompt-injection-prevention/test", validate(z.object({}).strict()), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(await service.test(companyId, getActorInfo(req).actorId));
  });
  return router;
}
