import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createWebhookSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { webhookService } from "../services/webhooks.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = webhookService(db);

  router.post("/companies/:companyId/webhooks", validate(createWebhookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const webhook = await svc.create(companyId, req.body, {
      userId: actor.actorType === "user" ? actor.actorId : null,
      agentId: actor.agentId ?? null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.created",
      entityType: "webhook",
      entityId: webhook.id,
      details: { url: webhook.url, eventTypes: webhook.eventTypes },
    });

    res.status(201).json(webhook);
  });

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.delete("/companies/:companyId/webhooks/:webhookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const webhookId = req.params.webhookId as string;
    assertCompanyAccess(req, companyId);

    const webhook = await svc.get(webhookId);
    if (!webhook || webhook.companyId !== companyId) {
      throw notFound("Webhook not found");
    }

    await svc.remove(webhookId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.deleted",
      entityType: "webhook",
      entityId: webhookId,
      details: { url: webhook.url },
    });

    res.status(204).end();
  });

  return router;
}
