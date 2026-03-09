import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createNotificationChannelSchema,
  updateNotificationChannelSchema,
  testNotificationChannelConfigSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, notificationService } from "../services/index.js";

export function notificationChannelRoutes(db: Db) {
  const router = Router();
  const svc = notificationService(db);

  // List all channels for a company
  router.get("/companies/:companyId/notification-channels", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const channels = await svc.list(companyId);
    res.json(channels);
  });

  // Create a new channel
  router.post(
    "/companies/:companyId/notification-channels",
    validate(createNotificationChannelSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const channel = await svc.create(companyId, req.body);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "notification_channel.created",
        entityType: "notification_channel",
        entityId: channel.id,
        details: { name: channel.name, channelType: channel.channelType },
      });

      res.status(201).json(channel);
    },
  );

  // Pre-save test: test config without saving
  router.post(
    "/companies/:companyId/notification-channels/test",
    validate(testNotificationChannelConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.testChannel(req.body.channelType, req.body.config);
      res.json(result);
    },
  );

  // Get a single channel
  router.get("/notification-channels/:id", async (req, res) => {
    assertBoard(req);
    const channel = await svc.get(req.params.id as string);
    assertCompanyAccess(req, channel.companyId);
    res.json(channel);
  });

  // Update a channel (channelType and companyId are immutable)
  router.patch(
    "/notification-channels/:id",
    validate(updateNotificationChannelSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await svc.get(req.params.id as string);
      assertCompanyAccess(req, existing.companyId);

      const updated = await svc.update(req.params.id as string, req.body);

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "notification_channel.updated",
        entityType: "notification_channel",
        entityId: updated.id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  // Delete a channel
  router.delete("/notification-channels/:id", async (req, res) => {
    assertBoard(req);
    const existing = await svc.get(req.params.id as string);
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(req.params.id as string);

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "notification_channel.deleted",
      entityType: "notification_channel",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  // Test an existing saved channel
  router.post("/notification-channels/:id/test", async (req, res) => {
    assertBoard(req);
    const raw = await svc.getRaw(req.params.id as string);
    assertCompanyAccess(req, raw.companyId);
    const result = await svc.testChannel(raw.channelType, raw.config);
    res.json(result);
  });

  return router;
}
