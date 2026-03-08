import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createWebhookSchema, updateWebhookSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, webhookService } from "../services/index.js";

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = webhookService(db);

  router.get("/companies/:companyId/webhooks", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const hooks = await svc.list(companyId);
    res.json(hooks);
  });

  router.post("/companies/:companyId/webhooks", validate(createWebhookSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(companyId, {
      url: req.body.url,
      secret: req.body.secret,
      events: req.body.events,
      description: req.body.description,
      enabled: req.body.enabled,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "webhook.created",
      entityType: "webhook",
      entityId: created.id,
      details: { url: created.url, events: created.events },
    });

    res.status(201).json(created);
  });

  router.patch("/webhooks/:id", validate(updateWebhookSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.update(id, {
      url: req.body.url,
      secret: req.body.secret,
      events: req.body.events,
      description: req.body.description,
      enabled: req.body.enabled,
    });

    if (!updated) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "webhook.updated",
      entityType: "webhook",
      entityId: updated.id,
      details: { url: updated.url, enabled: updated.enabled },
    });

    res.json(updated);
  });

  router.delete("/webhooks/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "webhook.deleted",
      entityType: "webhook",
      entityId: removed.id,
      details: { url: removed.url },
    });

    res.json({ ok: true });
  });

  router.post("/webhooks/:id/test", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const event = (existing.events as string[])[0] as import("@paperclipai/shared").WebhookEventType;
    await svc.deliverTo(existing, event, {
      test: true,
      message: "This is a test webhook from Paperclip.",
    });

    res.json({ ok: true, message: "Test webhook dispatched" });
  });

  return router;
}
