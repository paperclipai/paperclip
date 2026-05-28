import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { patchCompanyAwaitingHumanSettingsSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { awaitingHumanSettingsService, companyService, logActivity } from "../services/index.js";

export function companyAwaitingHumanSettingsRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const settings = awaitingHumanSettingsService(db);
  const companies = companyService(db);

  router.get("/", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as { companyId: string }).companyId;
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await settings.get(companyId));
  });

  router.patch("/", validate(patchCompanyAwaitingHumanSettingsSchema), async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as { companyId: string }).companyId;
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const body = req.body;
    const actor = getActorInfo(req);
    const updated = await settings.update(companyId, body, {
      userId: req.actor.userId,
      agentId: actor.agentId,
    });
    const redactedBody = "clickupPersonalToken" in body && body.clickupPersonalToken != null
      ? { ...body, clickupPersonalToken: "[REDACTED]" }
      : body;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.awaiting_human_settings.updated",
      entityType: "company",
      entityId: companyId,
      details: redactedBody,
    });
    res.json(updated);
  });

  return router;
}
