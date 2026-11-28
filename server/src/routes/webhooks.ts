import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createWebhookSchema,
  rotateWebhookSecretSchema,
  updateWebhookSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, webhookService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = webhookService(db);

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const webhooks = await svc.list(companyId);
    res.json(webhooks);
  });

  router.post("/companies/:companyId/webhooks", validate(createWebhookSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const created = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.created",
      entityType: "webhook_endpoint",
      entityId: created.id,
      details: { url: created.url, events: created.events },
    });
    res.status(201).json(created);
  });

  router.get("/webhooks/:id", async (req, res) => {
    assertBoard(req);
    const webhook = await svc.getById(req.params.id as string);
    if (!webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, webhook.companyId);
    res.json(webhook);
  });

  router.patch("/webhooks/:id", validate(updateWebhookSchema), async (req, res) => {
    assertBoard(req);
    const webhook = await svc.getById(req.params.id as string);
    if (!webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, webhook.companyId);
    const updated = await svc.update(webhook.id, req.body);
    if (!updated) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: webhook.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.updated",
      entityType: "webhook_endpoint",
      entityId: webhook.id,
      details: { url: updated.url, enabled: updated.enabled },
    });
    res.json(updated);
  });

  router.post(
    "/webhooks/:id/rotate-secret",
    validate(rotateWebhookSecretSchema),
    async (req, res) => {
      assertBoard(req);
      const webhook = await svc.getById(req.params.id as string);
      if (!webhook) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      assertCompanyAccess(req, webhook.companyId);
      const result = await svc.rotateSecret(webhook.id);
      if (!result) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: webhook.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "webhook.secret_rotated",
        entityType: "webhook_endpoint",
        entityId: webhook.id,
        details: {},
      });
      res.json(result);
    },
  );

  router.delete("/webhooks/:id", async (req, res) => {
    assertBoard(req);
    const webhook = await svc.getById(req.params.id as string);
    if (!webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, webhook.companyId);
    await svc.remove(webhook.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: webhook.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "webhook.deleted",
      entityType: "webhook_endpoint",
      entityId: webhook.id,
      details: { url: webhook.url },
    });
    res.status(204).end();
  });

  router.get("/webhooks/:id/deliveries", async (req, res) => {
    assertBoard(req);
    const webhook = await svc.getById(req.params.id as string);
    if (!webhook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, webhook.companyId);
    const limitParam = req.query["limit"];
    const limit = typeof limitParam === "string" ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50;
    const deliveries = await svc.listDeliveries(webhook.id, limit);
    res.json(deliveries);
  });

  return router;
}
