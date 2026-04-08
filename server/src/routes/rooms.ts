import { Router, type Request } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  addRoomParticipantSchema,
  createRoomSchema,
  linkRoomIssueSchema,
  sendRoomMessageSchema,
  updateActionStatusSchema,
  updateRoomSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { roomService, assetService, logActivity } from "../services/index.js";
import { assertRoomParticipant } from "../services/rooms.js";
import { MAX_ATTACHMENT_BYTES, isAllowedContentType } from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Build the actor key for room membership checks.
 */
function roomActor(req: any): { agentId?: string | null; userId?: string | null } {
  return {
    agentId: req.actor?.agentId ?? null,
    userId:
      req.actor?.type === "user" || req.actor?.type === "board"
        ? req.actor?.userId ?? null
        : null,
  };
}

/**
 * Assert that the caller is a participant of the given room. Uses a minimal
 * Drizzle `select` wrapper so the service helper can run outside a transaction.
 */
async function assertRoomMembership(db: any, roomId: string, req: any) {
  const actor = roomActor(req);
  await assertRoomParticipant({ select: (shape: any) => db.select(shape) }, roomId, actor);
}

function handleErr(res: any, err: any) {
  if (
    err?.status === 409 ||
    err?.status === 422 ||
    err?.status === 404 ||
    err?.status === 403
  ) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Assert room exists, company match, and caller is a participant.
 * Returns the room or null (response already sent).
 */
async function loadRoomForAccess(
  db: any,
  svc: ReturnType<typeof roomService>,
  req: any,
  res: any,
) {
  const room = await svc.getById(req.params.roomId as string);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return null;
  }
  assertCompanyAccess(req, room.companyId);
  try {
    await assertRoomMembership(db, room.id, req);
  } catch (err: any) {
    if (err?.status === 403) {
      res.status(403).json({ error: err.message });
      return null;
    }
    throw err;
  }
  return room;
}

export function roomRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = roomService(db);
  const assets = assetService(db);
  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  // === Rooms CRUD ===

  router.get("/companies/:companyId/rooms", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, roomActor(req)));
  });

  router.get("/companies/:companyId/rooms/:roomId", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    res.json(room);
  });

  router.post(
    "/companies/:companyId/rooms",
    validate(createRoomSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      try {
        const room = await svc.create(companyId, req.body, {
          agentId: actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "room.created",
          entityType: "room",
          entityId: room.id,
          details: { name: room.name },
        });
        res.status(201).json(room);
      } catch (err: any) {
        if (handleErr(res, err)) return;
        throw err;
      }
    },
  );

  router.patch(
    "/companies/:companyId/rooms/:roomId",
    validate(updateRoomSchema),
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      const updated = await svc.update(room.id, req.body);
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/rooms/:roomId", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    const archived = await svc.archive(room.id);
    res.json(archived);
  });

  // === Participants ===

  router.get("/companies/:companyId/rooms/:roomId/participants", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    res.json(await svc.listParticipants(room.id));
  });

  router.post(
    "/companies/:companyId/rooms/:roomId/participants",
    validate(addRoomParticipantSchema),
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      try {
        const row = await svc.addParticipant(room.id, room.companyId, req.body);
        if (!row) {
          res.status(409).json({ error: "Participant already in room" });
          return;
        }
        res.status(201).json(row);
      } catch (err: any) {
        if (handleErr(res, err)) return;
        throw err;
      }
    },
  );

  router.delete(
    "/companies/:companyId/rooms/:roomId/participants/:participantId",
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      const removed = await svc.removeParticipant(
        room.id,
        req.params.participantId as string,
      );
      if (!removed) {
        res.status(404).json({ error: "Participant not found in this room" });
        return;
      }
      res.json(removed);
    },
  );

  // === Messages ===

  router.get("/companies/:companyId/rooms/:roomId/messages", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await svc.listMessages(room.id, { limit }));
  });

  // Upload an attachment for a room. Returns asset metadata the client
  // then passes into sendMessage as the attachments field.
  router.post("/companies/:companyId/rooms/:roomId/attachments", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    try {
      await new Promise<void>((resolve, reject) => {
        attachmentUpload.single("file")(req, res, (err: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }
    const contentType = (file.mimetype || "application/octet-stream").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType}` });
      return;
    }
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId: room.companyId,
      namespace: `rooms/${room.id}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });
    const asset = await assets.create(room.companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" || actor.actorType === "board" ? actor.actorId : null,
    });
    res.status(201).json({
      assetId: asset.id,
      name: asset.originalFilename ?? "file",
      contentType: asset.contentType,
      size: asset.byteSize,
      url: `/api/assets/${asset.id}/content`,
      thumbnailUrl: null,
    });
  });

  router.post(
    "/companies/:companyId/rooms/:roomId/messages",
    validate(sendRoomMessageSchema),
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      const actor = getActorInfo(req);
      try {
        const msg = await svc.sendMessage(room.id, room.companyId, {
          ...req.body,
          senderAgentId: actor.agentId ?? null,
          senderUserId:
            actor.actorType === "user" || actor.actorType === "board"
              ? actor.actorId
              : null,
        });
        res.status(201).json(msg);
      } catch (err: any) {
        if (handleErr(res, err)) return;
        throw err;
      }
    },
  );

  router.patch(
    "/companies/:companyId/rooms/:roomId/messages/:messageId/action-status",
    validate(updateActionStatusSchema),
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      try {
        const updated = await svc.updateActionStatus(
          room.id,
          req.params.messageId as string,
          req.body.actionStatus,
          roomActor(req),
          { result: req.body.result, error: req.body.error },
        );
        if (!updated) {
          res.status(404).json({ error: "Action message not found in this room" });
          return;
        }
        res.json(updated);
      } catch (err: any) {
        if (handleErr(res, err)) return;
        throw err;
      }
    },
  );

  // === Issues link ===

  router.get("/companies/:companyId/rooms/:roomId/issues", async (req, res) => {
    const room = await loadRoomForAccess(db, svc, req, res);
    if (!room) return;
    res.json(await svc.listIssues(room.id));
  });

  router.post(
    "/companies/:companyId/rooms/:roomId/issues",
    validate(linkRoomIssueSchema),
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      const actor = getActorInfo(req);
      try {
        const row = await svc.linkIssue(room.id, room.companyId, req.body.issueId, {
          agentId: actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
        if (!row) {
          res.status(409).json({ error: "Issue already linked to room" });
          return;
        }
        res.status(201).json(row);
      } catch (err: any) {
        if (handleErr(res, err)) return;
        throw err;
      }
    },
  );

  router.delete(
    "/companies/:companyId/rooms/:roomId/issues/:issueId",
    async (req, res) => {
      const room = await loadRoomForAccess(db, svc, req, res);
      if (!room) return;
      const removed = await svc.unlinkIssue(room.id, req.params.issueId as string);
      if (!removed) {
        res.status(404).json({ error: "Issue not linked to this room" });
        return;
      }
      res.json(removed);
    },
  );

  return router;
}
