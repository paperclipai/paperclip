import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createChatMessageSchema,
  createChatThreadSchema,
  updateChatThreadSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { chatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function getSingleParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

function getSingleQueryParam(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function chatRoutes(db: Db) {
  const router = Router();
  const svc = chatService(db);

  router.get("/companies/:companyId/chat/threads", async (req, res) => {
    const companyId = getSingleParam(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: "Invalid company id" });
    assertCompanyAccess(req, companyId);
    const threads = await svc.listThreads(companyId, {
      issueId: getSingleQueryParam(req.query.issueId),
      status: getSingleQueryParam(req.query.status),
    });
    res.json(threads);
  });

  router.get("/chat/threads/:threadId", async (req, res) => {
    const threadId = getSingleParam(req.params.threadId);
    if (!threadId) return res.status(400).json({ error: "Invalid thread id" });
    const thread = await svc.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    assertCompanyAccess(req, thread.companyId);
    res.json(thread);
  });

  router.post("/companies/:companyId/chat/threads", validate(createChatThreadSchema), async (req, res) => {
    const companyId = getSingleParam(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: "Invalid company id" });
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const thread = await svc.createThread(companyId, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });
    res.status(201).json(thread);
  });

  router.patch("/chat/threads/:threadId", validate(updateChatThreadSchema), async (req, res) => {
    const threadId = getSingleParam(req.params.threadId);
    if (!threadId) return res.status(400).json({ error: "Invalid thread id" });
    const thread = await svc.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    assertCompanyAccess(req, thread.companyId);
    const updated = await svc.updateThread(threadId, req.body);
    res.json(updated);
  });

  router.get("/chat/threads/:threadId/messages", async (req, res) => {
    const threadId = getSingleParam(req.params.threadId);
    if (!threadId) return res.status(400).json({ error: "Invalid thread id" });
    const thread = await svc.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    assertCompanyAccess(req, thread.companyId);
    const limitParam = getSingleQueryParam(req.query.limit);
    const messages = await svc.listMessages(threadId, {
      limit: limitParam ? parseInt(limitParam, 10) : undefined,
    });
    res.json(messages);
  });

  router.post("/chat/threads/:threadId/messages", validate(createChatMessageSchema), async (req, res) => {
    const threadId = getSingleParam(req.params.threadId);
    if (!threadId) return res.status(400).json({ error: "Invalid thread id" });
    const thread = await svc.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    assertCompanyAccess(req, thread.companyId);
    const actor = getActorInfo(req);
    const message = await svc.createMessage(thread.companyId, thread.id, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });
    res.status(201).json(message);
  });

  return router;
}
