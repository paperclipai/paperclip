import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createChannelSchema,
  createChannelRouteSchema,
  listChannelMessagesQuerySchema,
  updateChannelSchema,
  updateChannelRouteSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { channelService, isSensitiveConfigKey } from "../services/channels.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function summarizeConfigKeys(config: unknown): { keys: string[]; sensitiveKeys: string[] } {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { keys: [], sensitiveKeys: [] };
  }
  const keys = Object.keys(config as Record<string, unknown>).sort();
  return {
    keys,
    sensitiveKeys: keys.filter(isSensitiveConfigKey),
  };
}

export function channelRoutes(db: Db) {
  const router = Router();
  const svc = channelService(db);

  // Channels CRUD
  router.get("/companies/:companyId/channels", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const result = await svc.listChannels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/channels", validate(createChannelSchema), async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const created = await svc.createChannel(companyId, req.body);
    const actor = getActorInfo(req);
    const { keys, sensitiveKeys } = summarizeConfigKeys(req.body?.config);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel.created",
      entityType: "channel",
      entityId: created.id,
      details: {
        platform: created.platform,
        name: created.name,
        direction: created.direction,
        configKeys: keys,
        sensitiveConfigKeys: sensitiveKeys,
      },
    });
    res.status(201).json(created);
  });

  router.get("/channels/:id", async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    res.json(channel);
  });

  router.patch("/channels/:id", validate(updateChannelSchema), async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    const updated = await svc.updateChannel(channel.companyId, channel.id, req.body);
    const actor = getActorInfo(req);
    const { keys: changedKeys, sensitiveKeys: changedSensitiveKeys } = summarizeConfigKeys(
      req.body?.config,
    );
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel.updated",
      entityType: "channel",
      entityId: updated.id,
      details: {
        fields: Object.keys(req.body ?? {}).sort(),
        configKeys: changedKeys,
        sensitiveConfigKeys: changedSensitiveKeys,
      },
    });
    res.json(updated);
  });

  router.delete("/channels/:id", async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    await svc.deleteChannel(channel.companyId, channel.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: channel.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel.deleted",
      entityType: "channel",
      entityId: channel.id,
      details: { platform: channel.platform, name: channel.name },
    });
    res.status(204).send();
  });

  // Routes CRUD
  router.get("/companies/:companyId/routes", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const result = await svc.listRoutes(companyId, channelId);
    res.json(result);
  });

  router.post("/companies/:companyId/routes", validate(createChannelRouteSchema), async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const created = await svc.createRoute(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel_route.created",
      entityType: "channel_route",
      entityId: created.id,
      details: {
        channelId: created.channelId,
        trigger: created.trigger,
        enabled: created.enabled,
      },
    });
    res.status(201).json(created);
  });

  router.patch("/routes/:id", validate(updateChannelRouteSchema), async (req, res) => {
    const route = await svc.getRoute(req.params.id as string);
    if (!route) {
      res.status(404).json({ error: "Channel route not found" });
      return;
    }
    assertCompanyAccess(req, route.companyId);
    const updated = await svc.updateRoute(route.companyId, route.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel_route.updated",
      entityType: "channel_route",
      entityId: updated.id,
      details: { fields: Object.keys(req.body ?? {}).sort() },
    });
    res.json(updated);
  });

  router.delete("/routes/:id", async (req, res) => {
    const route = await svc.getRoute(req.params.id as string);
    if (!route) {
      res.status(404).json({ error: "Channel route not found" });
      return;
    }
    assertCompanyAccess(req, route.companyId);
    await svc.deleteRoute(route.companyId, route.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: route.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel_route.deleted",
      entityType: "channel_route",
      entityId: route.id,
      details: { channelId: route.channelId, trigger: route.trigger },
    });
    res.status(204).send();
  });

  // Messages list
  router.get("/companies/:companyId/messages", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const parseResult = listChannelMessagesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parseResult.error.flatten() });
      return;
    }
    const result = await svc.listMessages(companyId, parseResult.data);
    res.json(result);
  });

  return router;
}
