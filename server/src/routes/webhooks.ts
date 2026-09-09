import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createWebhookSchema, updateWebhookSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { webhookService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = webhookService(db);

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const webhooks = await svc.list(companyId);
    res.json(webhooks);
  });

  router.post("/companies/:companyId/webhooks", validate(createWebhookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const webhook = await svc.create(companyId, req.body);
    res.status(201).json(webhook);
  });

  function requireCompanyId(req: Parameters<typeof assertCompanyAccess>[0]): string {
    const raw = req.query.companyId;
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id || typeof id !== "string") throw notFound("resource");
    return id;
  }

  router.get("/webhooks/:id", async (req, res) => {
    const { id } = req.params;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const webhook = await svc.get(id, companyId);
    if (!webhook) throw notFound("Webhook");
    res.json(webhook);
  });

  router.patch("/webhooks/:id", validate(updateWebhookSchema), async (req, res) => {
    const id = req.params.id as string;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const webhook = await svc.update(id, companyId, req.body);
    if (!webhook) throw notFound("Webhook");
    res.json(webhook);
  });

  router.delete("/webhooks/:id", async (req, res) => {
    const { id } = req.params;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const deleted = await svc.remove(id, companyId);
    if (!deleted) throw notFound("Webhook");
    res.status(204).send();
  });

  router.post("/webhooks/:id/test", async (req, res) => {
    const { id } = req.params;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const result = await svc.testWebhook(id, companyId);
    if (!result) throw notFound("Webhook");
    res.status(202).json(result);
  });

  router.get("/webhooks/:id/deliveries", async (req, res) => {
    const { id } = req.params;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const deliveries = await svc.listDeliveries(id, companyId);
    res.json(deliveries);
  });

  router.post("/webhook-deliveries/:deliveryId/retry", async (req, res) => {
    const { deliveryId } = req.params;
    const companyId = requireCompanyId(req);
    assertCompanyAccess(req, companyId);
    const ok = await svc.retryDelivery(deliveryId, companyId);
    if (!ok) throw notFound("Delivery");
    res.status(202).json({ deliveryId });
  });

  return router;
}
