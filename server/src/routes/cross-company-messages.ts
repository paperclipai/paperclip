import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { crossCompanyMessageService } from "../services/cross-company-messages.js";
import { validate } from "../middleware/validate.js";

const createCrossCompanyMessageSchema = z.object({
  destinationCompanyId: z.string().uuid(),
  messageType: z.string().trim().min(1).max(120),
  payload: z.unknown(),
});

const listQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

function requireAgentActor(req: Request, res: Response) {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
    res.status(403).json({ error: "Agent access required" });
    return null;
  }
  return {
    agentId: req.actor.agentId,
    companyId: req.actor.companyId,
  };
}

function toMessageResponse(message: Awaited<ReturnType<ReturnType<typeof crossCompanyMessageService>["enqueue"]>>) {
  return {
    id: message.id,
    cursor: message.cursor,
    sourceCompanyId: message.sourceCompanyId,
    sourceAgentId: message.sourceAgentId,
    destinationCompanyId: message.destinationCompanyId,
    idempotencyKey: message.idempotencyKey,
    messageType: message.messageType,
    payload: message.payload,
    ackedAt: message.ackedAt,
    ackedByAgentId: message.ackedByAgentId,
    createdAt: message.createdAt,
  };
}

export function crossCompanyMessageRoutes(db: Db) {
  const router = Router();
  const svc = crossCompanyMessageService(db);

  router.get("/outbox", async (req, res) => {
    const actor = requireAgentActor(req, res);
    if (!actor) return;
    const query = listQuerySchema.parse(req.query);
    const items = await svc.listOutbox(actor.companyId, query.after, query.limit);
    const maxCursor = items.reduce((max, item) => Math.max(max, item.cursor), query.after ?? 0);
    res.json({
      items: items.map(toMessageResponse),
      nextCursor: maxCursor,
    });
  });

  router.post("/outbox", validate(createCrossCompanyMessageSchema), async (req, res) => {
    const actor = requireAgentActor(req, res);
    if (!actor) return;
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      res.status(400).json({ error: "Idempotency-Key header is required" });
      return;
    }
    const message = await svc.enqueue({
      sourceCompanyId: actor.companyId,
      sourceAgentId: actor.agentId,
      destinationCompanyId: req.body.destinationCompanyId,
      idempotencyKey,
      messageType: req.body.messageType,
      payload: req.body.payload,
    });
    res.status(201).json(toMessageResponse(message));
  });

  router.get("/inbox", async (req, res) => {
    const actor = requireAgentActor(req, res);
    if (!actor) return;
    const query = listQuerySchema.parse(req.query);
    const items = await svc.listInbox(actor.companyId, query.after, query.limit);
    const maxCursor = items.reduce((max, item) => Math.max(max, item.cursor), query.after ?? 0);
    res.json({
      items: items.map(toMessageResponse),
      nextCursor: maxCursor,
    });
  });

  router.post("/inbox/:messageId/ack", async (req, res) => {
    const actor = requireAgentActor(req, res);
    if (!actor) return;
    const message = await svc.ack({
      destinationCompanyId: actor.companyId,
      messageId: req.params.messageId,
      ackedByAgentId: actor.agentId,
    });
    res.json(toMessageResponse(message));
  });

  return router;
}
