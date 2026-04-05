import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agentChannels } from "@ironworksai/db";
import { eq } from "drizzle-orm";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  ensureCompanyChannel,
  extractDecisions,
  getMessages,
  getPinnedMessages,
  listChannels,
  pinMessage,
  postMessage,
  unpinMessage,
} from "../services/channels.js";
import { channelAnalytics } from "../services/executive-analytics.js";

export function channelRoutes(db: Db) {
  const router = Router();

  // GET /api/companies/:companyId/channels
  router.get("/companies/:companyId/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Ensure at least the #company channel exists
    await ensureCompanyChannel(db, companyId);

    const channels = await listChannels(db, companyId);
    res.json(channels);
  });

  // GET /api/companies/:companyId/channels/:channelId/messages
  router.get("/companies/:companyId/channels/:channelId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);

    // Verify the channel belongs to this company
    const channel = await db
      .select({ id: agentChannels.id })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
      .then((rows) => rows[0] ?? null);

    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const before = typeof req.query.before === "string" ? req.query.before : undefined;

    const messages = await getMessages(db, channelId, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      before,
    });

    res.json(messages);
  });

  // POST /api/companies/:companyId/channels/:channelId/messages
  router.post("/companies/:companyId/channels/:channelId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);

    // Verify the channel belongs to this company
    const channel = await db
      .select({ id: agentChannels.id, companyId: agentChannels.companyId })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
      .then((rows) => rows[0] ?? null);

    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    if (channel.companyId !== companyId) {
      res.status(403).json({ error: "Channel does not belong to this company" });
      return;
    }

    const body = req.body as {
      body?: unknown;
      messageType?: unknown;
      mentions?: unknown;
      linkedIssueId?: unknown;
      replyToId?: unknown;
    };

    if (typeof body.body !== "string" || body.body.trim().length === 0) {
      res.status(400).json({ error: "body is required" });
      return;
    }

    const actor = getActorInfo(req);

    const message = await postMessage(db, {
      channelId,
      companyId,
      authorAgentId: actor.agentId ?? undefined,
      authorUserId: actor.actorType === "user" ? actor.actorId : undefined,
      body: body.body.trim(),
      messageType: typeof body.messageType === "string" ? body.messageType : "message",
      mentions: Array.isArray(body.mentions) ? (body.mentions as string[]) : [],
      linkedIssueId: typeof body.linkedIssueId === "string" ? body.linkedIssueId : undefined,
      replyToId: typeof body.replyToId === "string" ? body.replyToId : undefined,
    });

    // Broadcast SSE event to all connected clients for this company
    publishLiveEvent({
      companyId,
      type: "channel.message",
      payload: { message, channelId },
    });

    res.status(201).json(message);
  });

  // -------------------------------------------------------------------------
  // Enhancement 1: Decision Registry
  // GET /api/companies/:companyId/channels/:channelId/decisions
  // -------------------------------------------------------------------------
  router.get("/companies/:companyId/channels/:channelId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);

    const channel = await db
      .select({ id: agentChannels.id })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
      .then((rows) => rows[0] ?? null);

    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const sinceParam = typeof req.query.since === "string" ? req.query.since : undefined;
    const since = sinceParam ? new Date(sinceParam) : undefined;

    const decisions = await extractDecisions(db, channelId, since);
    res.json(decisions);
  });

  // -------------------------------------------------------------------------
  // Enhancement 4: Thread Pinning
  // POST   /api/companies/:companyId/channels/:channelId/messages/:messageId/pin
  // DELETE /api/companies/:companyId/channels/:channelId/messages/:messageId/pin
  // GET    /api/companies/:companyId/channels/:channelId/pinned
  // -------------------------------------------------------------------------
  router.post(
    "/companies/:companyId/channels/:channelId/messages/:messageId/pin",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      const messageId = req.params.messageId as string;
      assertCompanyAccess(req, companyId);

      const channel = await db
        .select({ id: agentChannels.id, companyId: agentChannels.companyId })
        .from(agentChannels)
        .where(eq(agentChannels.id, channelId))
        .then((rows) => rows[0] ?? null);

      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      if (channel.companyId !== companyId) {
        res.status(403).json({ error: "Channel does not belong to this company" });
        return;
      }

      await pinMessage(db, channelId, messageId);
      res.json({ ok: true });
    },
  );

  router.delete(
    "/companies/:companyId/channels/:channelId/messages/:messageId/pin",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      const messageId = req.params.messageId as string;
      assertCompanyAccess(req, companyId);

      const channel = await db
        .select({ id: agentChannels.id, companyId: agentChannels.companyId })
        .from(agentChannels)
        .where(eq(agentChannels.id, channelId))
        .then((rows) => rows[0] ?? null);

      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      if (channel.companyId !== companyId) {
        res.status(403).json({ error: "Channel does not belong to this company" });
        return;
      }

      await unpinMessage(db, channelId, messageId);
      res.json({ ok: true });
    },
  );

  router.get("/companies/:companyId/channels/:channelId/pinned", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);

    const channel = await db
      .select({ id: agentChannels.id })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
      .then((rows) => rows[0] ?? null);

    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const pinned = await getPinnedMessages(db, channelId);
    res.json(pinned);
  });

  // -------------------------------------------------------------------------
  // Enhancement 5: Channel Analytics
  // GET /api/companies/:companyId/channels/:channelId/analytics
  // -------------------------------------------------------------------------
  router.get("/companies/:companyId/channels/:channelId/analytics", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);

    const channel = await db
      .select({ id: agentChannels.id })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
      .then((rows) => rows[0] ?? null);

    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const periodDaysParam = typeof req.query.periodDays === "string"
      ? parseInt(req.query.periodDays, 10)
      : 30;
    const periodDays = Number.isFinite(periodDaysParam) && periodDaysParam > 0
      ? Math.min(periodDaysParam, 365)
      : 30;

    const data = await channelAnalytics(db, channelId, periodDays);
    res.json(data);
  });

  return router;
}
