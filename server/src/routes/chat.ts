import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { chatService, type ChatActor, type StreamEvent } from "../services/chat.js";
import { listAvailableModels } from "../services/chat-providers.js";
import { badRequest, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

function requireBoardActor(req: Request): ChatActor {
  if (req.actor.type !== "board") {
    throw forbidden("Chat is available to board users only");
  }
  if (!req.actor.userId) throw forbidden("Board user context required");
  return {
    userId: req.actor.userId,
    isInstanceAdmin: req.actor.isInstanceAdmin === true,
    companyIds: req.actor.companyIds ?? [],
  };
}

const createSessionSchema = z.object({
  title: z.string().max(200).optional(),
  companyId: z.string().nullable().optional(),
  mode: z.enum(["chat", "agent"]).optional(),
  permissionMode: z.enum(["ask", "bypass"]).optional(),
  model: z.string().max(100).optional(),
});

const patchSessionSchema = z.object({
  title: z.string().max(200).optional(),
  mode: z.enum(["chat", "agent"]).optional(),
  permissionMode: z.enum(["ask", "bypass"]).optional(),
  effort: z.enum(["auto", "low", "medium", "high"]).optional(),
  companyId: z.string().nullable().optional(),
  model: z.string().max(100).optional(),
});

const sendMessageSchema = z.object({
  text: z.string().min(1).max(50_000),
});

const permissionDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

function writeSseEvent(res: Response, event: StreamEvent | { type: "ping" }) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function chatRoutes(db: Db) {
  const router = Router();
  const svc = chatService(db);

  router.get("/chat/models", async (req, res) => {
    requireBoardActor(req);
    res.json({ models: await listAvailableModels() });
  });

  router.get("/chat/sessions", async (req, res) => {
    const actor = requireBoardActor(req);
    res.json({ sessions: await svc.listSessions(actor) });
  });

  router.post("/chat/sessions", async (req, res) => {
    const actor = requireBoardActor(req);
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const session = await svc.createSession(actor, parsed.data);
    res.status(201).json({ session });
  });

  router.patch("/chat/sessions/:id", async (req, res) => {
    const actor = requireBoardActor(req);
    const parsed = patchSessionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const session = await svc.updateSession(actor, req.params.id as string, parsed.data);
    res.json({ session });
  });

  router.delete("/chat/sessions/:id", async (req, res) => {
    const actor = requireBoardActor(req);
    await svc.deleteSession(actor, req.params.id as string);
    res.status(204).end();
  });

  router.get("/chat/sessions/:id", async (req, res) => {
    const actor = requireBoardActor(req);
    const session = await svc.getSession(actor, req.params.id as string);
    res.json({ session });
  });

  router.get("/chat/sessions/:id/messages", async (req, res) => {
    const actor = requireBoardActor(req);
    const messages = await svc.listMessages(actor, req.params.id as string);
    res.json({ messages });
  });

  router.post("/chat/sessions/:id/messages", async (req, res) => {
    const actor = requireBoardActor(req);
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, { type: "ping" });
      } catch {
        /* socket closed */
      }
    }, 15_000);
    heartbeat.unref?.();

    let abortFn: (() => void) | null = null;
    const handleClose = () => {
      clearInterval(heartbeat);
      abortFn?.();
    };
    res.on("close", handleClose);

    try {
      for await (const event of svc.runTurn(
        actor,
        req.params.id as string,
        parsed.data.text,
        (cb) => {
          abortFn = cb;
        },
      )) {
        writeSseEvent(res, event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId: req.params.id }, "Chat turn failed");
      try {
        writeSseEvent(res, { type: "error", error: message });
      } catch {
        /* socket closed */
      }
    } finally {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* already ended */
      }
    }
  });

  router.post("/chat/sessions/:id/permissions/:toolUseId", async (req, res) => {
    const actor = requireBoardActor(req);
    const parsed = permissionDecisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    await svc.resolvePermission(
      actor,
      req.params.id as string,
      req.params.toolUseId as string,
      parsed.data.decision,
    );
    res.json({ ok: true });
  });

  return router;
}
