import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companyMemberships,
  issues,
  rooms,
  roomParticipants,
  roomMessages,
  roomIssues,
} from "@paperclipai/db";
import type { RoomActionStatus, RoomMessageType } from "@paperclipai/shared";
import type { RoomStreamBus, RoomMessageLike, RoomParticipantLike } from "./room-stream-bus.js";
import type { AgentStreamBus } from "./agent-stream-bus.js";

export interface RoomServiceBuses {
  room?: RoomStreamBus;
  agent?: AgentStreamBus;
}

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

/**
 * Hard caps on parseMentions to bound pathological inputs. A 1 MB body
 * full of "@a" tokens would otherwise allocate ~300k match objects
 * before the dedup Set helps. We cap the body slice we scan and break
 * the match loop once dedup has seen enough distinct tokens.
 */
const MENTION_BODY_SCAN_CAP = 16 * 1024; // 16 KB of body is more than enough
const MENTION_MAX_DISTINCT = 64;

/**
 * Normalize a string for mention comparison: NFKC (collapses Unicode
 * compatibility forms, strips most zero-width tricks) + lowercase.
 * Identical normalization is applied to both the parsed mention token
 * and the agent name so a Cyrillic "Сyrus" won't match the Latin
 * leader "Cyrus" (they are genuinely different code points), BUT a
 * message that uses the leader's real non-ASCII name like `@한국` or
 * `@Léon` will correctly route to that leader.
 */
function normalizeMentionToken(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Parse `@mention` tokens out of a message body. Returns normalized
 * tokens in first-seen order. Used by the message fanout to decide
 * which leaders in a multi-leader room should receive the event.
 *
 * Rules:
 *   - Token class is Unicode letters/digits/`_`/`-` (`\p{L}`, `\p{N}`)
 *     so non-Latin agent names (`한국`, `Léon`, `тест`) work. Reviewed
 *     as Phase 5.2a P0: ASCII-only routing was a bypass — a leader
 *     with a non-matchable name was invisible to `@mention` and only
 *     received broadcast fanout, leaking unaddressed messages.
 *   - `@Hana`, `@hana`, `@Hana.` all yield "hana"
 *   - `user@example.com` does NOT match — we require start-of-string
 *     or a non-word/non-`@` character before the `@`
 *   - `@Cyrus@Hana` yields BOTH tokens (reviewed P1: consecutive
 *     mentions without whitespace previously dropped the second one)
 *   - Markdown links `[text](@name)` do NOT match: we strip
 *     `](...)` URL spans before scanning so attackers can't smuggle a
 *     wake-up inside an href
 *   - Hard-caps: only the first 16 KB of the body is scanned; the
 *     parser stops after 64 distinct tokens
 *
 * Exported for unit testing.
 */
export function parseMentions(body: string | null | undefined): string[] {
  if (!body) return [];
  // Truncate pathologically-large bodies before any regex work.
  let scan = body.length > MENTION_BODY_SCAN_CAP ? body.slice(0, MENTION_BODY_SCAN_CAP) : body;
  // Strip markdown link URL spans so `[label](@hana)` cannot smuggle
  // a mention. We replace the URL with empty parens, preserving the
  // label's own position so `[@hana](url)` still matches `hana`.
  scan = scan.replace(/\]\([^)]*\)/g, "]()");

  const out: string[] = [];
  const seen = new Set<string>();
  const tokenRe = /^[\p{L}\p{N}_\-]{1,64}/u;
  const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

  // Manual scan. Using matchAll with a lookbehind cannot handle
  // `@Cyrus@Hana` because position 6's preceding char is `s` (a word
  // character) even though the second `@` is clearly the start of a
  // new mention. We track the end of the last consumed mention so the
  // very next character can also be a valid leading boundary.
  let i = 0;
  let justConsumedEnd = -1;
  while (i < scan.length) {
    const at = scan.indexOf("@", i);
    if (at < 0) break;
    const okLeading =
      at === 0 || at === justConsumedEnd || !isWordChar(scan[at - 1]);
    if (okLeading) {
      const rest = scan.slice(at + 1);
      const m = rest.match(tokenRe);
      if (m) {
        const tok = normalizeMentionToken(m[0]);
        if (tok && !seen.has(tok)) {
          seen.add(tok);
          out.push(tok);
          if (seen.size >= MENTION_MAX_DISTINCT) break;
        }
        justConsumedEnd = at + 1 + m[0].length;
        i = justConsumedEnd;
        continue;
      }
    }
    i = at + 1;
  }
  return out;
}

/**
 * Decide which agent IDs should receive a channel notification for the
 * given message. The rules enforce Phase 5.1's §3 "When to reply"
 * guidance at the runtime level so a misbehaving Claude session cannot
 * double-answer messages not addressed to it.
 *
 * Algorithm:
 *   1. Fetch all participants of the room, joined with agents. The
 *      query ANDs on the room's own `companyId` — defence-in-depth
 *      against orphaned cross-tenant rows (Phase 5.2a P1 finding).
 *   2. Split participants into two sets:
 *        - leaders  = agents where adapterType === "claude_local"
 *        - others   = agents with any other adapter type (sub-agents)
 *                     Non-agent rows (users) are not routed through the
 *                     agent bus at all — the existing UI/WS path keeps
 *                     delivering to them.
 *   3. **Action target override** — if the message carries an explicit
 *      `actionTargetAgentId`, only that agent is delivered (regardless
 *      of mentions or leader/other split).
 *   4. **Empty body short-circuit** — if the body is empty/whitespace
 *      and no action target, deliver to NOBODY. There is nothing for
 *      Claude to read, so waking every leader is pure noise. (Phase
 *      5.2a P1 finding.)
 *   5. Otherwise parse @mentions from the body and:
 *        - If mentions ∩ leader-names is non-empty → deliver to THAT
 *          subset of leaders only.
 *        - Otherwise → deliver to ALL leaders (original broadcast
 *          behaviour for unaddressed messages).
 *   6. Always deliver to every non-leader agent in the room.
 *   7. NEVER deliver to the sender agent — the self-loop guard lives
 *      both here (cheap) and in the bridge (defence in depth).
 *
 * Returns both the authoritative delivery list (`deliveredLeaderIds`
 * + `others`) AND the full candidate `allLeaders` / `allOthers` lists
 * for logging/audit. Callers MUST use the delivered lists for fanout;
 * the "all" fields are explicitly marked as candidates.
 *
 * Exported for unit testing.
 */
export async function resolveMessageAudience(
  db: Db,
  roomId: string,
  body: string | null | undefined,
  senderAgentId: string | null | undefined,
  actionTargetAgentId?: string | null,
): Promise<{
  /** All leaders in the room (minus sender), before any filtering. */
  allLeaders: Array<{ agentId: string; name: string }>;
  /** All non-leader agents in the room (minus sender), before filtering. */
  allOthers: Array<{ agentId: string; name: string }>;
  /** Parsed mentions from the body (normalized, deduped). */
  mentioned: string[];
  /** Leaders that should actually receive the event. Use this. */
  deliveredLeaderIds: string[];
  /** Sub-agents that should actually receive the event. Use this. */
  deliveredOtherIds: string[];
  /** True if at least one mention matched a leader. */
  mentionHit: boolean;
  /** True if an action target override was applied. */
  actionTargeted: boolean;
}> {
  // Fetch the room's companyId first so we can AND it into the
  // participant/agent join below. This closes the defence-in-depth gap
  // where an orphaned cross-tenant row in room_participants (which
  // shouldn't exist, but could from a migration bug) would otherwise
  // leak events to a foreign-company agent.
  const [roomRow] = await db
    .select({ companyId: rooms.companyId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!roomRow) {
    return {
      allLeaders: [],
      allOthers: [],
      mentioned: [],
      deliveredLeaderIds: [],
      deliveredOtherIds: [],
      mentionHit: false,
      actionTargeted: false,
    };
  }

  const rows = await db
    .select({
      agentId: roomParticipants.agentId,
      adapterType: agents.adapterType,
      name: agents.name,
    })
    .from(roomParticipants)
    .innerJoin(agents, eq(roomParticipants.agentId, agents.id))
    .where(
      and(
        eq(roomParticipants.roomId, roomId),
        eq(roomParticipants.companyId, roomRow.companyId),
        eq(agents.companyId, roomRow.companyId),
      ),
    );

  const allLeaders: Array<{ agentId: string; name: string }> = [];
  const allOthers: Array<{ agentId: string; name: string }> = [];
  for (const r of rows) {
    if (!r.agentId) continue;
    if (senderAgentId && r.agentId === senderAgentId) continue; // self-loop guard
    if (r.adapterType === "claude_local") {
      allLeaders.push({ agentId: r.agentId, name: r.name });
    } else {
      allOthers.push({ agentId: r.agentId, name: r.name });
    }
  }

  // Parse mentions once — used both by the action-targeted return
  // (logged/audited) and by the main routing path.
  const mentions = parseMentions(body);

  // Action messages with a concrete target agent override mentions.
  // The sender has explicitly said "this task goes to this agent" and
  // every other leader should stay quiet. We still deliver to the
  // target even if they are a sub-agent (non-leader).
  if (actionTargetAgentId && actionTargetAgentId !== senderAgentId) {
    const targetLeader = allLeaders.find((l) => l.agentId === actionTargetAgentId);
    const targetOther = allOthers.find((o) => o.agentId === actionTargetAgentId);
    return {
      allLeaders,
      allOthers,
      mentioned: mentions, // still reported — audit trail preserves intent
      deliveredLeaderIds: targetLeader ? [targetLeader.agentId] : [],
      deliveredOtherIds: targetOther ? [targetOther.agentId] : [],
      mentionHit: false,
      actionTargeted: true,
    };
  }

  // Empty/whitespace-only body has nothing for Claude to read. Waking
  // every leader on such a message is pure noise (and a small DoS
  // vector — an attacker could POST 10k empty messages and flood every
  // CLI with no-op notifications). Short-circuit.
  const isBodyEmpty = !body || body.trim().length === 0;
  if (isBodyEmpty) {
    return {
      allLeaders,
      allOthers,
      mentioned: [],
      deliveredLeaderIds: [],
      deliveredOtherIds: [],
      mentionHit: false,
      actionTargeted: false,
    };
  }

  // Index leader names (normalized same as parseMentions) for O(1)
  // lookup. UUIDs are also accepted so humans can @<uuid> to
  // disambiguate agents with identical names.
  const leaderByNormalizedName = new Map<string, string>();
  for (const l of allLeaders) {
    leaderByNormalizedName.set(normalizeMentionToken(l.name), l.agentId);
  }
  const leaderIdSet = new Set(allLeaders.map((l) => l.agentId));

  const hitIds = new Set<string>();
  for (const tok of mentions) {
    const byName = leaderByNormalizedName.get(tok);
    if (byName) hitIds.add(byName);
    else if (leaderIdSet.has(tok)) hitIds.add(tok);
  }

  const mentionHit = hitIds.size > 0;
  const deliveredLeaders = mentionHit
    ? allLeaders.filter((l) => hitIds.has(l.agentId))
    : allLeaders;

  return {
    allLeaders,
    allOthers,
    mentioned: mentions,
    deliveredLeaderIds: deliveredLeaders.map((l) => l.agentId),
    deliveredOtherIds: allOthers.map((o) => o.agentId),
    mentionHit,
    actionTargeted: false,
  };
}

/**
 * Fan out a freshly-created or updated room message to the room bus and
 * the participating agents' buses. Runs after the DB transaction commits
 * so subscribers see a row that definitely exists. Fetching the current
 * participant list is a cheap lookup on the indexed (roomId) column.
 *
 * message.created events use `resolveMessageAudience` so that `@mention`
 * in a multi-leader room only wakes the mentioned leader(s). Update
 * events bypass the mention filter and fan out to every participant
 * (minus the sender) because a status/edit transition is relevant to
 * everyone watching.
 */
async function fanoutMessageEvent(
  db: Db,
  roomId: string,
  eventKind: "message.created" | "message.updated",
  message: RoomMessageLike,
  buses?: RoomServiceBuses,
): Promise<void> {
  if (!buses?.room && !buses?.agent) return;

  if (buses.room) {
    buses.room.publish(roomId, { type: eventKind, roomId, message });
  }

  if (!buses.agent) return;

  if (eventKind === "message.created") {
    const audience = await resolveMessageAudience(
      db,
      roomId,
      message.body ?? "",
      message.senderAgentId ?? null,
      message.actionTargetAgentId ?? null,
    );
    const targets = new Set<string>([
      ...audience.deliveredLeaderIds,
      ...audience.deliveredOtherIds,
    ]);
    for (const agentId of targets) {
      buses.agent.publish(agentId, { type: eventKind, roomId, message });
    }
    return;
  }

  // message.updated → deliver to every participant agent (broad fanout)
  const participants = await db
    .select({ agentId: roomParticipants.agentId })
    .from(roomParticipants)
    .where(eq(roomParticipants.roomId, roomId));
  for (const p of participants) {
    if (!p.agentId) continue;
    if (message.senderAgentId && p.agentId === message.senderAgentId) continue;
    buses.agent.publish(p.agentId, { type: eventKind, roomId, message });
  }
}

export function roomService(db: Db, buses?: RoomServiceBuses) {
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
      const row = await db.transaction(async (tx) => {
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
      if (row) {
        buses?.room?.publish(roomId, {
          type: "participant.joined",
          roomId,
          participant: row as RoomParticipantLike,
        });
        // Newly-added agent should learn its full room list.
        if (row.agentId && buses?.agent) {
          const rooms = await db
            .select({ roomId: roomParticipants.roomId })
            .from(roomParticipants)
            .where(eq(roomParticipants.agentId, row.agentId));
          buses.agent.publish(row.agentId, {
            type: "membership.changed",
            roomIds: rooms.map((r) => r.roomId),
          });
        }
      }
      return row;
    },

    removeParticipant: async (roomId: string, participantId: string) => {
      const [row] = await db
        .delete(roomParticipants)
        .where(
          and(eq(roomParticipants.id, participantId), eq(roomParticipants.roomId, roomId)),
        )
        .returning();
      if (row) {
        buses?.room?.publish(roomId, {
          type: "participant.left",
          roomId,
          participantId: row.id,
        });
        if (row.agentId && buses?.agent) {
          const rooms = await db
            .select({ roomId: roomParticipants.roomId })
            .from(roomParticipants)
            .where(eq(roomParticipants.agentId, row.agentId));
          buses.agent.publish(row.agentId, {
            type: "membership.changed",
            roomIds: rooms.map((r) => r.roomId),
          });
        }
      }
      return row ?? null;
    },

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
        // Phase 5.2f — when true on an action message, the service
        // creates a companion `approvals` row and links it via
        // `approvalId`. The "Mark executed" UI button is gated on that
        // approval reaching the `approved` state.
        requiresApproval?: boolean;
      },
    ) => {
      const row = await db.transaction(async (tx) => {
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

        // Phase 5.2f — auto-create an approvals row for gated action
        // messages. We insert the approval BEFORE the message so the
        // message can carry the FK atomically in the same transaction.
        // Non-action messages + plain action messages without the flag
        // keep `approvalId = null`.
        let approvalId: string | null = null;
        if (type === "action" && data.requiresApproval) {
          const [approvalRow] = await tx
            .insert(approvals)
            .values({
              companyId,
              type: "action_execution",
              status: "pending",
              requestedByAgentId: data.senderAgentId ?? null,
              requestedByUserId: data.senderUserId ?? null,
              payload: {
                roomId,
                actionTargetAgentId: data.actionTargetAgentId ?? null,
                body: data.body,
                actionPayload: data.actionPayload ?? null,
              },
            })
            .returning({ id: approvals.id });
          approvalId = approvalRow?.id ?? null;
        }

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
            approvalId,
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
      // Publish after commit so subscribers always see a persisted row.
      await fanoutMessageEvent(db, roomId, "message.created", row as RoomMessageLike, buses);
      return row;
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
      const { row, changed } = await db.transaction(async (tx): Promise<{
        row: typeof roomMessages.$inferSelect | null;
        changed: boolean;
      }> => {
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
            approvalId: roomMessages.approvalId,
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

        // Phase 5.2f — if the action message is gated by an approval,
        // block the terminal transition until the approval is in the
        // `approved` state. A `rejected` approval blocks forever (the
        // operator must create a new action). Ungated messages (null
        // approvalId) skip this check.
        if (msg.approvalId && nextStatus === "executed") {
          const [gate] = await tx
            .select({ status: approvals.status })
            .from(approvals)
            .where(eq(approvals.id, msg.approvalId))
            .limit(1);
          if (!gate) {
            throw Object.assign(
              new Error(`Linked approval not found`),
              { status: 409 },
            );
          }
          if (gate.status !== "approved") {
            throw Object.assign(
              new Error(
                `Action requires approval (current state: ${gate.status}). Approve it first.`,
              ),
              { status: 409 },
            );
          }
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
          return { row: existing ?? null, changed: false };
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

        const [updated] = await tx
          .update(roomMessages)
          .set({
            actionStatus: nextStatus,
            actionResult: nextStatus === "executed" ? (extras.result ?? null) : null,
            actionError: nextStatus === "failed" ? (extras.error ?? null) : null,
            // Phase 5.2f hardening: `actionExecutedAt` is a
            // "successfully executed at" timestamp. Setting it on the
            // `failed` path muddled the semantics — callers reading
            // `actionExecutedAt IS NOT NULL` as a proxy for "did
            // execute" would get false positives. Only stamp it on
            // the executed transition.
            actionExecutedAt: nextStatus === "executed" ? new Date() : null,
            actionExecutedByAgentId: actor.agentId ?? null,
            actionExecutedByUserId: actor.userId ?? null,
          })
          .where(eq(roomMessages.id, messageId))
          .returning();
        return { row: updated ?? null, changed: true };
      });
      // Only fan out on actual transitions (not idempotent re-apply).
      if (changed && row) {
        await fanoutMessageEvent(db, roomId, "message.updated", row as RoomMessageLike, buses);
      }
      return row;
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
