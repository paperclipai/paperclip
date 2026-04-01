import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { validate } from "../middleware/validate.js";
import { chatService, heartbeatService, issueService, logActivity } from "../services/index.js";
import { publishLiveEvent } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const createRoomSchema = z.object({
  kind: z.enum(["direct", "boardroom"]),
  agentId: z.string().uuid().optional(),
});

const postMessageSchema = z.object({
  body: z.string().min(1).max(100_000),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

export function chatRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);
  const chatSvc = chatService(db);

  // List rooms for a company
  router.get("/companies/:companyId/chat/rooms", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rooms = await chatSvc.listRooms(companyId);
    res.json(rooms);
  });

  // Get single room
  router.get("/companies/:companyId/chat/rooms/:roomId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const roomId = req.params.roomId as string;
    assertCompanyAccess(req, companyId);

    const room = await chatSvc.getRoom(roomId, companyId);
    if (!room) {
      res.status(404).json({ error: "Chat room not found" });
      return;
    }
    res.json(room);
  });

  // Find-or-create room
  router.post(
    "/companies/:companyId/chat/rooms",
    validate(createRoomSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { kind, agentId } = req.body as z.infer<typeof createRoomSchema>;

      if (kind === "direct") {
        if (!agentId) {
          res.status(400).json({ error: "agentId is required for direct rooms" });
          return;
        }

        const result = await chatSvc.getOrCreateDirectRoom(companyId, agentId);
        if (result.error === "agent_not_found") {
          res.status(404).json({ error: "Agent not found" });
          return;
        }

        res.status(result.created ? 201 : 200).json(result.room);
        return;
      }

      // Boardroom
      const result = await chatSvc.getOrCreateBoardroom(companyId);
      res.status(result.created ? 201 : 200).json(result.room);
    },
  );

  // List messages for a room (cursor-based, newest first)
  router.get("/companies/:companyId/chat/rooms/:roomId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const roomId = req.params.roomId as string;
    assertCompanyAccess(req, companyId);

    // Verify room exists and belongs to company
    const room = await chatSvc.getRoom(roomId, companyId);
    if (!room) {
      res.status(404).json({ error: "Chat room not found" });
      return;
    }

    const limitRaw =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const before =
      typeof req.query.before === "string" && req.query.before.trim().length > 0
        ? req.query.before.trim()
        : undefined;

    const messages = await chatSvc.listMessages(roomId, { before, limit: limitRaw });

    // Attach attachments to messages
    const messageIds = messages.map(m => m.id);
    const attachmentMap = await chatSvc.listMessageAttachments(messageIds);
    const messagesWithAttachments = messages.map(m => ({
      ...m,
      attachments: (attachmentMap.get(m.id) ?? []).map(a => ({
        ...a,
        contentPath: `/api/assets/${a.assetId}/content`,
      })),
    }));
    res.json(messagesWithAttachments);
  });

  // Post a message
  router.post(
    "/companies/:companyId/chat/rooms/:roomId/messages",
    validate(postMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const roomId = req.params.roomId as string;
      assertCompanyAccess(req, companyId);

      const room = await chatSvc.getRoom(roomId, companyId);
      if (!room) {
        res.status(404).json({ error: "Chat room not found" });
        return;
      }

      const actor = getActorInfo(req);
      const body: string = req.body.body;

      const message = await chatSvc.addMessage(roomId, body, {
        companyId,
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId ?? undefined,
      });

      // Publish live event
      publishLiveEvent({
        companyId,
        type: "chat.message.created",
        payload: {
          chatRoomId: roomId,
          messageId: message.id,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          roomKind: room.kind,
        },
      });

      // Log activity
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "chat.message_added",
        entityType: "chat_room",
        entityId: roomId,
        details: {
          messageId: message.id,
          bodySnippet: body.slice(0, 120),
          roomKind: room.kind,
          roomAgentId: room.agentId,
        },
      });

      // Trigger agent wakeups (fire-and-forget)
      void (async () => {
        const actorIsAgent = actor.actorType === "agent";

        if (room.kind === "direct" && room.agentId) {
          // Direct chat: wake the room's agent (unless it's the author)
          if (actorIsAgent && actor.actorId === room.agentId) return;
          heartbeat
            .wakeup(room.agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "chat_message",
              payload: { chatRoomId: roomId, messageId: message.id },
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
              contextSnapshot: {
                chatRoomId: roomId,
                messageId: message.id,
                wakeReason: "chat_message",
                source: "chat.direct",
              },
            })
            .catch((err) =>
              logger.warn({ err, roomId, agentId: room.agentId }, "failed to wake agent on chat message"),
            );
        } else if (room.kind === "boardroom") {
          // Boardroom: wake only @mentioned agents
          let mentionedIds: string[] = [];
          try {
            mentionedIds = await issueSvc.findMentionedAgents(companyId, body);
          } catch (err) {
            logger.warn({ err, roomId }, "failed to resolve @-mentions in boardroom message");
          }

          for (const agentId of mentionedIds) {
            if (actorIsAgent && actor.actorId === agentId) continue;
            heartbeat
              .wakeup(agentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "chat_message_mentioned",
                payload: { chatRoomId: roomId, messageId: message.id },
                requestedByActorType: actor.actorType,
                requestedByActorId: actor.actorId,
                contextSnapshot: {
                  chatRoomId: roomId,
                  messageId: message.id,
                  wakeReason: "chat_message_mentioned",
                  source: "chat.boardroom",
                },
              })
              .catch((err) =>
                logger.warn({ err, roomId, agentId }, "failed to wake agent on boardroom mention"),
              );
          }
        }
      })();

      res.status(201).json(message);
    },
  );

  // Post a message with file attachment
  router.post(
    "/companies/:companyId/chat/rooms/:roomId/messages/with-attachment",
    upload.single("file"),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const roomId = req.params.roomId as string;
      assertCompanyAccess(req, companyId);

      const room = await chatSvc.getRoom(roomId, companyId);
      if (!room) {
        res.status(404).json({ error: "Chat room not found" });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "File is required" });
        return;
      }

      const contentType = file.mimetype;
      if (!isAllowedContentType(contentType)) {
        res.status(400).json({ error: `Content type ${contentType} is not allowed` });
        return;
      }

      const actor = getActorInfo(req);
      const body: string = typeof req.body.body === "string" ? req.body.body : "";

      // Store the file
      const stored = await storage.putFile({
        companyId,
        namespace: "chat/messages",
        originalFilename: file.originalname || null,
        contentType,
        body: file.buffer,
      });

      // Create the message
      const message = await chatSvc.addMessage(roomId, body, {
        companyId,
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId ?? undefined,
      });

      // Create the attachment
      const attachment = await chatSvc.createAttachment({
        companyId,
        chatMessageId: message.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      // Publish live event
      publishLiveEvent({
        companyId,
        type: "chat.message.created",
        payload: {
          chatRoomId: roomId,
          messageId: message.id,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          roomKind: room.kind,
        },
      });

      // Log activity
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "chat.message_added",
        entityType: "chat_room",
        entityId: roomId,
        details: {
          messageId: message.id,
          bodySnippet: body.slice(0, 120),
          roomKind: room.kind,
          roomAgentId: room.agentId,
          attachmentId: attachment.id,
          attachmentContentType: attachment.contentType,
          attachmentByteSize: attachment.byteSize,
        },
      });

      // Trigger agent wakeups (fire-and-forget)
      void (async () => {
        const actorIsAgent = actor.actorType === "agent";

        if (room.kind === "direct" && room.agentId) {
          if (actorIsAgent && actor.actorId === room.agentId) return;
          heartbeat
            .wakeup(room.agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "chat_message",
              payload: { chatRoomId: roomId, messageId: message.id },
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
              contextSnapshot: {
                chatRoomId: roomId,
                messageId: message.id,
                wakeReason: "chat_message",
                source: "chat.direct",
              },
            })
            .catch((err) =>
              logger.warn({ err, roomId, agentId: room.agentId }, "failed to wake agent on chat message"),
            );
        } else if (room.kind === "boardroom") {
          let mentionedIds: string[] = [];
          try {
            mentionedIds = await issueSvc.findMentionedAgents(companyId, body);
          } catch (err) {
            logger.warn({ err, roomId }, "failed to resolve @-mentions in boardroom message");
          }

          for (const agentId of mentionedIds) {
            if (actorIsAgent && actor.actorId === agentId) continue;
            heartbeat
              .wakeup(agentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "chat_message_mentioned",
                payload: { chatRoomId: roomId, messageId: message.id },
                requestedByActorType: actor.actorType,
                requestedByActorId: actor.actorId,
                contextSnapshot: {
                  chatRoomId: roomId,
                  messageId: message.id,
                  wakeReason: "chat_message_mentioned",
                  source: "chat.boardroom",
                },
              })
              .catch((err) =>
                logger.warn({ err, roomId, agentId }, "failed to wake agent on boardroom mention"),
              );
          }
        }
      })();

      res.status(201).json({
        ...message,
        attachments: [{
          ...attachment,
          contentPath: `/api/assets/${attachment.assetId}/content`,
        }],
      });
    },
  );

  return router;
}
