import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sendMessageSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { communicationService, logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";

export function messageRoutes(db: Db) {
  const router = Router();
  const svc = communicationService(db);

  // Send a message (agent-to-agent or broadcast)
  router.post(
    "/companies/:companyId/messages",
    validate(sendMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      if (actor.actorType !== "agent" || !actor.agentId) {
        throw forbidden("Only agents can send messages");
      }

      const message = await svc.send(companyId, actor.agentId, {
        channel: req.body.channel,
        toAgentId: req.body.toAgentId,
        messageType: req.body.messageType,
        subject: req.body.subject,
        body: req.body.body,
        payload: req.body.payload,
        parentMessageId: req.body.parentMessageId,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
        priority: req.body.priority,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "message.sent",
        entityType: "message",
        entityId: message.id,
        details: {
          channel: message.channel,
          toAgentId: message.toAgentId,
          messageType: message.messageType,
        },
      });

      res.status(201).json(message);
    },
  );

  // List messages in a channel
  router.get("/companies/:companyId/messages/channel/:channel", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channel = req.params.channel as string;
    assertCompanyAccess(req, companyId);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const messages = await svc.channel(companyId, channel, limit);
    res.json(messages);
  });

  // Get agent inbox
  router.get(
    "/companies/:companyId/agents/:agentId/messages/inbox",
    async (req, res) => {
      const { companyId, agentId } = req.params;
      assertCompanyAccess(req, companyId as string);
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const channel = req.query.channel as string | undefined;
      const messages = await svc.inbox(agentId as string, { channel, limit });
      res.json(messages);
    },
  );

  // Get agent sent messages
  router.get(
    "/companies/:companyId/agents/:agentId/messages/sent",
    async (req, res) => {
      const { companyId, agentId } = req.params;
      assertCompanyAccess(req, companyId as string);
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const messages = await svc.sent(agentId as string, limit);
      res.json(messages);
    },
  );

  // Get message thread
  router.get("/messages/:id/thread", async (req, res) => {
    const message = await svc.getById(req.params.id as string);
    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    assertCompanyAccess(req, message.companyId);
    const thread = await svc.thread(req.params.id as string);
    res.json(thread);
  });

  // Acknowledge a message
  router.post("/messages/:id/acknowledge", async (req, res) => {
    const message = await svc.getById(req.params.id as string);
    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    assertCompanyAccess(req, message.companyId);
    const acknowledged = await svc.acknowledge(req.params.id as string);
    res.json(acknowledged);
  });

  return router;
}
