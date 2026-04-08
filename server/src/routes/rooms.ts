import { Router } from "express";
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
import { roomService, logActivity } from "../services/index.js";
import { assertRoomParticipant } from "../services/rooms.js";
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

export function roomRoutes(db: Db) {
  const router = Router();
  const svc = roomService(db);

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
