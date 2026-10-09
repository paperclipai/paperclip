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
import { listAdapterModels } from "../adapters/registry.js";
import { parseCostDateRange, parseCostLimit } from "./costs.js";

export function fastResponseRoutes(db: Db) {
  const router = Router();
  const service = fastResponseService(db, {
    budgetHooks: {
      cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork,
    },
  });
  const base = "/companies/:companyId/fast-response";
  router.get(base, async (req, res) => {
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
  router.put(base, validate(updateFastResponseSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(
      await service.configure(companyId, getActorInfo(req).actorId, req.body),
    );
  });
  router.get(`${base}/models`, async (req, res) => {
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
        : (connection.routing?.models ??
          (await listAdapterModels(
            (
              {
                openai: "codex_local",
                anthropic: "claude_local",
                google: "gemini_local",
                xai: "grok_local",
              } as Record<string, string>
            )[connection.provider],
          )));
    res.json(models);
  });
  router.get(`${base}/availability`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await service.availability(companyId, getActorInfo(req).actorId));
  });
  router.post(`${base}/test`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden();
    res.json(await service.test(companyId, getActorInfo(req).actorId));
  });
  router.get(`${base}/history`, async (req, res) => {
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
