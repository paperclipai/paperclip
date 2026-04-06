import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentMessageService, logActivity, heartbeatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentMessageRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const svc = agentMessageService(db, heartbeat);

  router.post("/companies/:companyId/agent-messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { fromAgentId, toAgentId, broadcastScope, messageType, subject, body, metadata } = req.body;

    if (!fromAgentId || !body) {
      res.status(400).json({ error: "fromAgentId and body are required" });
      return;
    }

    const msg = await svc.send({
      companyId,
      fromAgentId,
      toAgentId: toAgentId ?? null,
      broadcastScope: broadcastScope ?? null,
      messageType: messageType ?? "general",
      subject: subject ?? null,
      body,
      metadata: metadata ?? undefined,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_message.sent",
      entityType: "agent_message",
      entityId: msg.id,
      details: { fromAgentId, toAgentId, messageType: messageType ?? "general" },
    });

    res.status(201).json(msg);
  });

  router.get("/companies/:companyId/agent-messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string;
    const unreadOnly = req.query.unreadOnly === "true";

    if (!agentId) {
      res.status(400).json({ error: "agentId query param required" });
      return;
    }

    const messages = await svc.listForAgent(companyId, agentId, { unreadOnly });
    res.json(messages);
  });

  router.patch("/agent-messages/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const updated = await svc.markRead(id);
    if (!updated) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(updated);
  });

  return router;
}
