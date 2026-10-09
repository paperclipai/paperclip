import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DECISION_TEST_REQUEST, updateDecisionModelSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { decisionModelService, settingsDecisionTest } from "../services/decision-models.js";
import { heartbeatService } from "../services/heartbeat.js";
import { parseCostDateRange, parseCostLimit } from "./costs.js";

export function decisionModelRoutes(db: Db) {
  const router = Router();
  const service = decisionModelService(db, { budgetHooks: { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork } });
  router.get("/companies/:companyId/decision-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    if (!canManage) { res.json({ canManage, settings: null, choices: [] }); return; }
    res.json({ canManage, settings: await service.settings(companyId), choices: await service.choices(companyId, getActorInfo(req).actorId) });
  });
  router.put("/companies/:companyId/decision-model", validate(updateDecisionModelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    res.json(await service.configure(companyId, getActorInfo(req).actorId, req.body));
  });
  router.get("/companies/:companyId/decision-model/availability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.availability({ companyId, actor: req.actor, feature: settingsDecisionTest }));
  });
  router.post("/companies/:companyId/decision-model/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    // The client cannot supply a prompt, model, identity, or background flag.
    res.json(await service.decide({ companyId, actor: req.actor, feature: settingsDecisionTest }, DECISION_TEST_REQUEST));
  });
  router.get("/companies/:companyId/decision-model/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.history(companyId, req.actor, { ...parseCostDateRange(req.query), limit: parseCostLimit(req.query) }));
  });
  return router;
}
