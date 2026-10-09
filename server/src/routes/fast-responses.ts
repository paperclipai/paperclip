import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { updateFastResponseSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { fastResponseService } from "../services/fast-responses.js";
import { heartbeatService } from "../services/heartbeat.js";
import { listOpenRouterModels } from "../services/openrouter-models.js";
import { fastResponseCatalogModels } from "../services/fast-response-models.js";
import { parseCostDateRange, parseCostLimit } from "./costs.js";

export function fastResponseRoutes(db: Db) {
  const router = Router();
  const service = fastResponseService(db, {
    budgetHooks: {
      cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork,
    },
  });
  router.get("/companies/:companyId/fast-response", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    res.json(
      canManage
        ? {
            canManage,
            settings: await service.settings(companyId),
            choices: await service.choices(
              companyId,
              getActorInfo(req).actorId,
            ),
          }
        : { canManage, settings: null, choices: [] },
    );
  });
  router.put("/companies/:companyId/fast-response", validate(updateFastResponseSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(
      await service.configure(companyId, getActorInfo(req).actorId, req.body),
    );
  });
  router.get("/companies/:companyId/fast-response/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    const choices = await service.choices(companyId, getActorInfo(req).actorId);
    const connection = choices.find((c) => c.id === req.query.connectionId);
    if (!connection) throw forbidden();
    const models =
      connection.provider === "openrouter" ||
      connection.routing?.kind === "openrouter"
        ? (await listOpenRouterModels()).map((m) => ({
            ...m,
            id: m.id.replace(/^openrouter\//, ""),
          }))
        : fastResponseCatalogModels(connection);
    res.json(models);
  });
  router.get("/companies/:companyId/fast-response/availability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await service.availability(companyId, getActorInfo(req).actorId));
  });
  router.post("/companies/:companyId/fast-response/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(await service.test(companyId, getActorInfo(req).actorId));
  });
  router.get("/companies/:companyId/fast-response/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(
      await service.history(companyId, req.actor, {
        ...parseCostDateRange(req.query),
        limit: parseCostLimit(req.query),
      }),
    );
  });
  return router;
}
