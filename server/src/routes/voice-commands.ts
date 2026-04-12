import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { voiceCommandService } from "../services/voice-commands.js";
import { chatService } from "../services/chats.js";
import { heartbeatService } from "../services/heartbeat.js";
import { agentService } from "../services/agents.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  rawText: z.string().min(1),
  routerAgentId: z.string().uuid().optional(),
  chatId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  classification: z.string().optional(),
  actionTaken: z.string().optional(),
  createdIssueId: z.string().uuid().optional(),
  chatId: z.string().uuid().optional(),
  status: z.enum(["pending", "queued", "processing", "completed", "corrected", "failed"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const correctSchema = z.object({
  correctionText: z.string().min(1),
  previousClassification: z.string().nullable().optional().default(null),
  newClassification: z.string().nullable().optional().default(null),
  previousIssueId: z.string().uuid().nullable().optional().default(null),
  newIssueId: z.string().uuid().nullable().optional().default(null),
  action: z.enum(["reclassified", "cancelled", "recreated", "updated"]),
});

// ─── Shared helper: create a chat and wake the router for a voice command ───
async function wakeRouter({
  svc,
  chats,
  heartbeat,
  companyId,
  routerAgentId,
  userId,
  cmdId,
  rawText,
}: {
  svc: ReturnType<typeof voiceCommandService>;
  chats: ReturnType<typeof chatService>;
  heartbeat: ReturnType<typeof heartbeatService>;
  companyId: string;
  routerAgentId: string;
  userId: string;
  cmdId: string;
  rawText: string;
}) {
  const chat = await chats.createChat({ companyId, agentId: routerAgentId, initiatedByUserId: userId });
  const chatId = chat.id;

  await svc.update(cmdId, companyId, { chatId, status: "processing" });

  const wrappedPrompt = [
    `VOICE COMMAND (id: ${cmdId})`,
    `From: ${userId}`,
    ``,
    `"${rawText}"`,
    ``,
    `Classify this voice command and take action. Update the voice command record when done.`,
  ].join("\n");

  const msg = await chats.addUserMessage({ companyId, chatId, body: wrappedPrompt });

  const run = await heartbeat.wakeup(routerAgentId, {
    source: "on_demand",
    triggerDetail: "manual",
    reason: "direct_chat",
    payload: { chatId, messageId: msg.id, voiceCommandId: cmdId },
    requestedByActorType: "user",
    requestedByActorId: userId,
    contextSnapshot: {
      wakeReason: "direct_chat",
      chatId,
      chatMessageId: msg.id,
      chatMessage: wrappedPrompt,
      voiceCommandId: cmdId,
      rawText,
    },
  });

  return { chatId, routerRun: run ?? null };
}

export function voiceCommandRoutes(db: Db) {
  const router = Router();
  const svc = voiceCommandService(db);
  const chats = chatService(db);
  const heartbeat = heartbeatService(db);
  const agents = agentService(db);

  // List voice commands for a company
  router.get("/companies/:companyId/voice-commands", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const opts = {
      initiatedByUserId: req.query.userId as string | undefined,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
    };

    const commands = await svc.list(companyId, opts);
    res.json(commands);
  });

  // Get status counts
  router.get("/companies/:companyId/voice-commands/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const userId = req.query.userId as string | undefined;
    const stats = await svc.countByStatus(companyId, userId);
    res.json(stats);
  });

  // Create a voice command
  router.post(
    "/companies/:companyId/voice-commands",
    validate(createSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);

      const userId = (req.actor as { userId: string }).userId;
      const routerAgentId = req.body.routerAgentId;

      let chatId = req.body.chatId;
      let routerRun: { id: string } | null = null;

      // If the router is already processing a command, queue this one
      const processingCount = routerAgentId ? await svc.getProcessingCount(companyId) : 0;
      const shouldQueue = routerAgentId && processingCount > 0;

      const cmd = await svc.create({
        companyId,
        initiatedByUserId: userId,
        rawText: req.body.rawText,
        routerAgentId,
        chatId,
        metadata: req.body.metadata,
        initialStatus: shouldQueue ? "queued" : "pending",
      });

      if (routerAgentId && !shouldQueue) {
        const agent = await agents.getById(routerAgentId);
        if (agent && agent.companyId === companyId) {
          const result = await wakeRouter({
            svc,
            chats,
            heartbeat,
            companyId,
            routerAgentId,
            userId,
            cmdId: cmd.id,
            rawText: req.body.rawText,
          });
          chatId = result.chatId;
          routerRun = result.routerRun;
        }
      }

      res.status(201).json({ ...cmd, status: shouldQueue ? "queued" : "processing", chatId, routerRunId: routerRun?.id ?? null });
    },
  );

  // Get a single voice command
  router.get("/voice-commands/:id", async (req, res) => {
    const id = req.params.id as string;

    const cmd = await svc.getById(id);
    if (!cmd) {
      res.status(404).json({ error: "Voice command not found" });
      return;
    }
    assertCompanyAccess(req, cmd.companyId);
    res.json(cmd);
  });

  // Update a voice command (used by router agent to fill in classification/action)
  router.patch(
    "/voice-commands/:id",
    validate(updateSchema),
    async (req, res) => {
      const id = req.params.id as string;

      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const updated = await svc.update(id, existing.companyId, req.body);
      if (!updated) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }

      // When a command finishes, promote the next queued one
      const newStatus = req.body.status;
      if ((newStatus === "completed" || newStatus === "failed") && existing.routerAgentId) {
        const next = await svc.promoteNextQueued(existing.companyId);
        if (next?.routerAgentId) {
          const agent = await agents.getById(next.routerAgentId);
          if (agent) {
            // Use a system user id derived from the original initiator — best we have in this context
            await wakeRouter({
              svc,
              chats,
              heartbeat,
              companyId: existing.companyId,
              routerAgentId: next.routerAgentId,
              userId: next.initiatedByUserId,
              cmdId: next.id,
              rawText: next.rawText,
            });
          }
        }
      }

      res.json(updated);
    },
  );

  // Delete a voice command
  router.delete("/voice-commands/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;

    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Voice command not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await svc.remove(id, existing.companyId);
    res.status(204).end();
  });

  // Submit a correction for a voice command
  router.post(
    "/voice-commands/:id/correct",
    validate(correctSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;

      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const corrected = await svc.addCorrection(id, existing.companyId, req.body);
      if (!corrected) {
        res.status(404).json({ error: "Voice command not found" });
        return;
      }

      // If there's a router agent, wake it with correction context
      if (existing.routerAgentId) {
        const agent = await agents.getById(existing.routerAgentId);
        if (agent) {
          const corrUserId = (req.actor as { userId: string }).userId;
          const corrChat = await chats.createChat({
            companyId: existing.companyId,
            agentId: existing.routerAgentId,
            initiatedByUserId: corrUserId,
          });

          const corrPrompt = [
            `VOICE CORRECTION (voiceCommandId: ${id})`,
            ``,
            `Original input: "${existing.rawText}"`,
            `Original classification: ${existing.classification ?? "unknown"}`,
            `Original action: ${existing.actionTaken ?? "unknown"}`,
            `Original issue: ${existing.createdIssueId ?? "none"}`,
            ``,
            `Correction: "${req.body.correctionText}"`,
            `Correction action: ${req.body.action}`,
            ``,
            `Rectify this mistake, update the voice command, and log the correction to Obsidian.`,
          ].join("\n");

          const msg = await chats.addUserMessage({
            companyId: existing.companyId,
            chatId: corrChat.id,
            body: corrPrompt,
          });

          await heartbeat.wakeup(existing.routerAgentId, {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "direct_chat",
            payload: { chatId: corrChat.id, messageId: msg.id, voiceCommandId: id },
            requestedByActorType: "user",
            requestedByActorId: corrUserId,
            contextSnapshot: {
              wakeReason: "direct_chat",
              chatId: corrChat.id,
              chatMessageId: msg.id,
              chatMessage: corrPrompt,
              voiceCommandId: id,
              correctionText: req.body.correctionText,
              originalClassification: existing.classification,
              originalIssueId: existing.createdIssueId,
            },
          });
        }
      }

      res.json(corrected);
    },
  );

  return router;
}
