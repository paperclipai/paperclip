import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  issues,
  rooms,
  roomParticipants,
  roomMessages,
  roomIssues,
} from "@paperclipai/db";
import type { RoomActionStatus, RoomMessageType } from "@paperclipai/shared";

async function assertAgentInCompany(
  tx: { select: Db["select"] },
  agentId: string,
  companyId: string,
): Promise<void> {
  const [row] = await tx
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
  }
  if (row.companyId !== companyId) {
    throw Object.assign(new Error(`Agent ${agentId} does not belong to this company`), {
      status: 422,
    });
  }
}

async function assertUserInCompany(
  tx: { select: Db["select"] },
  userId: string,
  companyId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!row) {
    throw Object.assign(
      new Error(`User ${userId} is not an active member of this company`),
      { status: 422 },
    );
  }
}

/**
 * Assert that the given actor (agent or user) is a participant of the room.
 * Throws 403 otherwise. Returns the matching participant row.
 *
 * This enforces the "rooms are private" contract — assertCompanyAccess
 * only checks company-level access, not room-level membership.
 */
export async function assertRoomParticipant(
  tx: { select: Db["select"] },
  roomId: string,
  actor: { agentId?: string | null; userId?: string | null },
): Promise<{ id: string; role: string; agentId: string | null; userId: string | null }> {
  if (!actor.agentId && !actor.userId) {
    throw Object.assign(new Error(`Anonymous actor cannot access room`), { status: 403 });
  }
  const conds = [eq(roomParticipants.roomId, roomId)];
  if (actor.agentId) {
    conds.push(eq(roomParticipants.agentId, actor.agentId));
  } else if (actor.userId) {
    conds.push(eq(roomParticipants.userId, actor.userId));
  }
  const [row] = await tx
    .select({
      id: roomParticipants.id,
      role: roomParticipants.role,
      agentId: roomParticipants.agentId,
      userId: roomParticipants.userId,
    })
    .from(roomParticipants)
    .where(and(...conds))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error(`Not a participant of this room`), { status: 403 });
  }
  return row;
}

export function roomService(db: Db) {
  return {
    /**
     * List rooms in a company, filtered to rooms the caller is a participant of.
     * Prevents information leak of private room names to non-members.
     */
    list: (
      companyId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      // Subquery: room_ids the actor participates in
      const participantConds = [eq(roomParticipants.companyId, companyId)];
      if (actor.agentId) {
        participantConds.push(eq(roomParticipants.agentId, actor.agentId));
      } else if (actor.userId) {
        participantConds.push(eq(roomParticipants.userId, actor.userId));
      } else {
        return Promise.resolve([]);
      }
      return db
        .select({
          id: rooms.id,
          companyId: rooms.companyId,
          name: rooms.name,
          description: rooms.description,
          status: rooms.status,
          createdByUserId: rooms.createdByUserId,
          createdByAgentId: rooms.createdByAgentId,
          createdAt: rooms.createdAt,
          updatedAt: rooms.updatedAt,
        })
        .from(rooms)
        .innerJoin(
          roomParticipants,
          and(
            eq(roomParticipants.roomId, rooms.id),
            ...participantConds,
          ),
        )
        .where(and(eq(rooms.companyId, companyId), ne(rooms.status, "deleted")))
        .orderBy(desc(rooms.createdAt));
    },

    getById: (id: string) =>
      db
        .select()
        .from(rooms)
        .where(eq(rooms.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (
      companyId: string,
      data: { name: string; description?: string | null },
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      return db.transaction(async (tx) => {
        // Validate creator belongs to this company (P0 — code-reviewer)
        if (actor.agentId) {
          await assertAgentInCompany(tx, actor.agentId, companyId);
        }
        if (actor.userId) {
          await assertUserInCompany(tx, actor.userId, companyId);
        }
        const [room] = await tx
          .insert(rooms)
          .values({
            companyId,
            name: data.name,
            description: data.description ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          })
          .returning();
        // Auto-add creator as owner participant
        if (actor.agentId || actor.userId) {
          await tx.insert(roomParticipants).values({
            roomId: room.id,
            companyId,
            agentId: actor.agentId ?? null,
            userId: actor.userId ?? null,
            role: "owner",
          });
        }
        return room;
      });
    },

    update: async (
      id: string,
      data: { name?: string; description?: string | null; status?: string },
    ) => {
      const [row] = await db
        .update(rooms)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(rooms.id, id))
        .returning();
      return row ?? null;
    },

    archive: (id: string) =>
      db
        .update(rooms)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(rooms.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    // === Participants ===

    listParticipants: (roomId: string) =>
      db
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.roomId, roomId))
        .orderBy(asc(roomParticipants.joinedAt)),

    addParticipant: async (
      roomId: string,
      companyId: string,
      data: { agentId?: string; userId?: string; role?: string },
    ) => {
      if (!data.agentId && !data.userId) {
        throw Object.assign(new Error(`Must provide agentId or userId`), { status: 422 });
      }
      return db.transaction(async (tx) => {
        if (data.agentId) {
          await assertAgentInCompany(tx, data.agentId, companyId);
        }
        if (data.userId) {
          await assertUserInCompany(tx, data.userId, companyId);
        }
        const [row] = await tx
          .insert(roomParticipants)
          .values({ roomId, companyId, ...data })
          .onConflictDoNothing()
          .returning();
        return row ?? null;
      });
    },

    removeParticipant: (roomId: string, participantId: string) =>
      db
        .delete(roomParticipants)
        .where(
          and(eq(roomParticipants.id, participantId), eq(roomParticipants.roomId, roomId)),
        )
        .returning()
        .then((rows) => rows[0] ?? null),

    // === Messages ===

    listMessages: (roomId: string, opts?: { limit?: number; before?: Date }) => {
      const limit = Math.min(opts?.limit ?? 100, 500);
      const conds = [eq(roomMessages.roomId, roomId)];
      // Note: 'before' filter omitted in this slice; UI fetches latest 100.
      return db
        .select()
        .from(roomMessages)
        .where(and(...conds))
        .orderBy(asc(roomMessages.createdAt))
        .limit(limit);
    },

    sendMessage: async (
      roomId: string,
      companyId: string,
      data: {
        type?: RoomMessageType;
        body: string;
        attachments?: Array<{
          assetId: string;
          name: string;
          contentType: string;
          size: number;
          url: string;
          thumbnailUrl?: string | null;
        }> | null;
        actionPayload?: Record<string, unknown> | null;
        actionTargetAgentId?: string | null;
        replyToId?: string | null;
        senderAgentId?: string | null;
        senderUserId?: string | null;
      },
    ) => {
      return db.transaction(async (tx) => {
        // Verify room exists in company
        const [room] = await tx
          .select({ companyId: rooms.companyId })
          .from(rooms)
          .where(eq(rooms.id, roomId))
          .limit(1);
        if (!room) {
          throw Object.assign(new Error(`Room ${roomId} not found`), { status: 404 });
        }
        if (room.companyId !== companyId) {
          throw Object.assign(new Error(`Room ${roomId} does not belong to this company`), {
            status: 422,
          });
        }
        // Cross-tenant validation on sender + target
        if (data.senderAgentId) {
          await assertAgentInCompany(tx, data.senderAgentId, companyId);
        }
        if (data.senderUserId) {
          await assertUserInCompany(tx, data.senderUserId, companyId);
        }
        if (data.actionTargetAgentId) {
          await assertAgentInCompany(tx, data.actionTargetAgentId, companyId);
        }
        // Validate replyToId scope
        if (data.replyToId) {
          const [parent] = await tx
            .select({
              roomId: roomMessages.roomId,
              companyId: roomMessages.companyId,
            })
            .from(roomMessages)
            .where(eq(roomMessages.id, data.replyToId))
            .limit(1);
          if (!parent) {
            throw Object.assign(new Error(`Reply target not found`), { status: 422 });
          }
          if (parent.companyId !== companyId || parent.roomId !== roomId) {
            throw Object.assign(
              new Error(`Reply target does not belong to this room`),
              { status: 422 },
            );
          }
        }
        const type = data.type ?? "text";
        const [row] = await tx
          .insert(roomMessages)
          .values({
            roomId,
            companyId,
            type,
            body: data.body,
            attachments: data.attachments && data.attachments.length > 0 ? data.attachments : null,
            actionPayload: data.actionPayload ?? null,
            actionTargetAgentId: data.actionTargetAgentId ?? null,
            actionStatus: type === "action" ? "pending" : null,
            replyToId: data.replyToId ?? null,
            senderAgentId: data.senderAgentId ?? null,
            senderUserId: data.senderUserId ?? null,
          })
          .returning();
        // Bump room.updatedAt for sort
        await tx
          .update(rooms)
          .set({ updatedAt: new Date() })
          .where(eq(rooms.id, roomId));
        return row;
      });
    },

    /**
     * Update an action message's status. Only allows the target agent (or a
     * room owner) to transition pending → executed | failed.
     *
     * Concurrency: SELECT acquires a row-level `FOR UPDATE` lock inside the
     * transaction so two simultaneous "execute" calls serialize — the second
     * sees the already-executed row and either succeeds idempotently
     * (same terminal state + same actor) or returns 409 (different terminal
     * state, non-owner, or different actor).
     *
     * Idempotency: re-applying the SAME terminal state is NOT an error — the
     * stored row is returned unchanged. This lets CLI executors retry a
     * flaky network hop without faking 409 handling. Transitioning to a
     * DIFFERENT terminal state still returns 409 (terminal state sticks).
     *
     * Audit: executedAt / executedBy{Agent,User}Id / actionResult /
     * actionError are captured on the first successful transition.
     */
    updateActionStatus: async (
      roomId: string,
      messageId: string,
      nextStatus: RoomActionStatus,
      actor: { agentId?: string | null; userId?: string | null },
      extras: { result?: Record<string, unknown>; error?: string } = {},
    ) => {
      return db.transaction(async (tx) => {
        // Must be a room participant
        const participant = await assertRoomParticipant(tx, roomId, actor);

        // Load the action message scoped to this room, with a row lock so
        // concurrent callers serialize on the same message. READ COMMITTED
        // without FOR UPDATE would race — both readers see "pending" and
        // both write.
        const [msg] = await tx
          .select({
            id: roomMessages.id,
            type: roomMessages.type,
            actionStatus: roomMessages.actionStatus,
            actionTargetAgentId: roomMessages.actionTargetAgentId,
          })
          .from(roomMessages)
          .where(
            and(
              eq(roomMessages.id, messageId),
              eq(roomMessages.roomId, roomId),
              eq(roomMessages.type, "action"),
            ),
          )
          .for("update")
          .limit(1);
        if (!msg) {
          throw Object.assign(new Error(`Action message not found in this room`), {
            status: 404,
          });
        }

        // Authorization: only the target agent or a room owner may update
        const isTarget =
          actor.agentId && msg.actionTargetAgentId && actor.agentId === msg.actionTargetAgentId;
        const isOwner = participant.role === "owner";
        if (!isTarget && !isOwner) {
          throw Object.assign(
            new Error(`Only the target agent or a room owner may update action status`),
            { status: 403 },
          );
        }

        if (nextStatus !== "executed" && nextStatus !== "failed") {
          throw Object.assign(
            new Error(`Invalid terminal action_status "${nextStatus}"`),
            { status: 422 },
          );
        }

        // Idempotency: same terminal state is a no-op that returns the
        // already-stored row (including its original execution audit).
        if (msg.actionStatus === nextStatus) {
          const [existing] = await tx
            .select()
            .from(roomMessages)
            .where(eq(roomMessages.id, messageId))
            .limit(1);
          return existing ?? null;
        }

        // Transition guard: any OTHER already-terminal state is a 409.
        if (msg.actionStatus !== "pending") {
          throw Object.assign(
            new Error(
              `Cannot transition action_status from "${msg.actionStatus}" to "${nextStatus}"`,
            ),
            { status: 409 },
          );
        }

        const [row] = await tx
          .update(roomMessages)
          .set({
            actionStatus: nextStatus,
            actionResult: nextStatus === "executed" ? (extras.result ?? null) : null,
            actionError: nextStatus === "failed" ? (extras.error ?? null) : null,
            actionExecutedAt: new Date(),
            actionExecutedByAgentId: actor.agentId ?? null,
            actionExecutedByUserId: actor.userId ?? null,
          })
          .where(eq(roomMessages.id, messageId))
          .returning();
        return row ?? null;
      });
    },

    // === Issues link (N:M) ===

    listIssues: (roomId: string) =>
      db
        .select({
          roomId: roomIssues.roomId,
          issueId: roomIssues.issueId,
          linkedAt: roomIssues.linkedAt,
          issue: {
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
          },
        })
        .from(roomIssues)
        .innerJoin(issues, eq(roomIssues.issueId, issues.id))
        .where(eq(roomIssues.roomId, roomId))
        .orderBy(asc(roomIssues.linkedAt)),

    linkIssue: async (
      roomId: string,
      companyId: string,
      issueId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      return db.transaction(async (tx) => {
        const [issue] = await tx
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .limit(1);
        if (!issue) {
          throw Object.assign(new Error(`Issue ${issueId} not found`), { status: 404 });
        }
        if (issue.companyId !== companyId) {
          throw Object.assign(
            new Error(`Issue ${issueId} does not belong to this company`),
            { status: 422 },
          );
        }
        const [row] = await tx
          .insert(roomIssues)
          .values({
            roomId,
            issueId,
            companyId,
            linkedByAgentId: actor.agentId ?? null,
            linkedByUserId: actor.userId ?? null,
          })
          .onConflictDoNothing()
          .returning();
        return row ?? null;
      });
    },

    unlinkIssue: (roomId: string, issueId: string) =>
      db
        .delete(roomIssues)
        .where(and(eq(roomIssues.roomId, roomId), eq(roomIssues.issueId, issueId)))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
