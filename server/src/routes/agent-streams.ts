/**
 * Agent-scoped SSE stream endpoint.
 *
 * Phase 4: the single endpoint a leader CLI's channel-bridge-cos
 * subscribes to at startup. Emits all room events the agent should
 * see (messages + membership + instructions updates), filtered by
 * current room_participants membership.
 *
 * Cursor-based resume (`?since=<messageId>`) guarantees exactly-once
 * delivery across reconnects.
 *
 * @see docs/cos-v2/phase4-cli-design.md §8
 */

import { Router } from "express";
import { asc, eq, gt, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { roomMessages, roomParticipants } from "@paperclipai/db";
import type { AgentStreamBus } from "../services/agent-stream-bus.js";
import type { AgentStreamEvent } from "../services/agent-stream-bus.js";
import { resolveMessageAudience } from "../services/rooms.js";
import type { RoomMessageLike } from "../services/room-stream-bus.js";

interface Deps {
  db: Db;
  agentStreamBus: AgentStreamBus;
}

function writeSseHeaders(res: import("express").Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function writeSseEvent(
  res: import("express").Response,
  event: { id?: string; event?: string; data: unknown },
) {
  if (event.id) res.write(`id: ${event.id}\n`);
  if (event.event) res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export function agentStreamRoutes(deps: Deps) {
  const router = Router();
  const { db, agentStreamBus } = deps;

  /**
   * GET /companies/:companyId/agents/:agentId/stream?since=<messageId>
   *
   * Auth: Bearer agent_api_key (middleware sets req.actor.type = "agent")
   * Authz: req.actor.agentId === :agentId AND req.actor.companyId === :companyId
   */
  router.get(
    "/companies/:companyId/agents/:agentId/stream",
    async (req, res) => {
      const { companyId, agentId } = req.params as {
        companyId: string;
        agentId: string;
      };

      // Authorization
      if (req.actor.type !== "agent") {
        res.status(401).json({ error: "Agent authentication required" });
        return;
      }
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only subscribe to its own stream" });
        return;
      }
      if (req.actor.companyId !== companyId) {
        res.status(403).json({ error: "Agent does not belong to this company" });
        return;
      }

      const sinceId =
        typeof req.query.since === "string" && req.query.since.length > 0
          ? req.query.since
          : null;

      writeSseHeaders(res);
      res.write(":ok\n\n");

      // Keepalive heartbeat so idle proxies don't kill the connection
      const keepalive = setInterval(() => {
        if (res.writable) res.write(":keepalive\n\n");
      }, 15_000);

      // Buffer events received during replay so we can dedup + flush
      let replaying = true;
      const buffered: AgentStreamEvent[] = [];
      // Dedup cursor — a monotonic timestamp, consistent with the DB
      // replay query which uses createdAt-based ordering (gt(...)).
      // Using message.id (UUID) for comparison is wrong: v4 UUIDs are
      // random, not sortable.
      let lastDeliveredAt: Date | null = null;

      const unsubscribe = agentStreamBus.subscribe(agentId, (evt) => {
        if (!res.writable) return;
        if (replaying) {
          buffered.push(evt);
          return;
        }
        deliver(evt);
      });

      function messageCreatedAt(
        evt: Extract<AgentStreamEvent, { type: "message.created" | "message.updated" }>,
      ): Date {
        const raw = evt.message.createdAt;
        return raw instanceof Date ? raw : new Date(raw as string);
      }

      // Dedup only applies to message.created — action-status updates
      // re-use the original row's createdAt, so createdAt-based dedup
      // would drop legitimate message.updated events after any newer
      // message has been delivered. Updates are always passed through.
      function deliver(evt: AgentStreamEvent) {
        if (evt.type === "message.created") {
          const at = messageCreatedAt(evt);
          if (lastDeliveredAt && at <= lastDeliveredAt) return;
          lastDeliveredAt = at;
        }
        // ALL events are emitted as the default "message" SSE event.
        // EventSource only fires the 'message' listener for unnamed
        // events; custom event names (participant.joined, etc.) are
        // silently dropped by default. The event type is already in
        // the JSON payload (evt.type) — the client switches on that.
        writeSseEvent(res, {
          id:
            evt.type === "message.created" || evt.type === "message.updated"
              ? evt.message.id
              : undefined,
          data: evt,
        });
      }

      // --- Replay phase ---

      try {
        // Determine cursor boundary from sinceId (if any)
        let sinceCreatedAt: Date | null = null;
        if (sinceId) {
          const [cursorRow] = await db
            .select({ createdAt: roomMessages.createdAt })
            .from(roomMessages)
            .where(eq(roomMessages.id, sinceId))
            .limit(1);
          sinceCreatedAt = cursorRow?.createdAt ?? null;
        }

        // List the rooms this agent currently participates in
        const participantRows = await db
          .select({ roomId: roomParticipants.roomId })
          .from(roomParticipants)
          .where(
            and(
              eq(roomParticipants.agentId, agentId),
              eq(roomParticipants.companyId, companyId),
            ),
          );
        const roomIds = participantRows.map((r) => r.roomId);

        if (roomIds.length > 0) {
          // Pull messages from each room since the cursor, sorted by
          // createdAt ASC. For simplicity we do one query per room —
          // rooms per agent are typically small (<20).
          //
          // Microsecond-precision caveat: Postgres `timestamp with
          // time zone` stores 6 digits of fractional seconds, but a
          // JS Date has millisecond precision. Reading the cursor
          // row's createdAt into a JS Date rounds away the μs tail,
          // so `gt(stored_ts, rounded_ts)` can return the cursor
          // row itself (stored value > its rounded version). We
          // therefore filter the cursor row by id in application
          // code as a safety net.
          const backlog: RoomMessageLike[] = [];
          for (const rid of roomIds) {
            const conds = [eq(roomMessages.roomId, rid)];
            if (sinceCreatedAt) {
              conds.push(gt(roomMessages.createdAt, sinceCreatedAt));
            }
            const rows = await db
              .select()
              .from(roomMessages)
              .where(and(...conds))
              .orderBy(asc(roomMessages.createdAt))
              .limit(sinceId ? 1000 : 100);
            for (const row of rows) {
              if (sinceId && row.id === sinceId) continue;
              backlog.push(row as unknown as RoomMessageLike);
            }
          }

          // Sort merged backlog globally by createdAt
          backlog.sort((a, b) => {
            const at = new Date(a.createdAt as any).getTime();
            const bt = new Date(b.createdAt as any).getTime();
            return at - bt;
          });

          for (const msg of backlog) {
            // Apply the same speaker-control routing filter used for
            // live messages. Without this, a reconnecting agent would
            // receive ALL missed messages regardless of topic/mention
            // routing, causing every agent to respond to every message
            // on restart.
            const audience = await resolveMessageAudience(
              db,
              msg.roomId,
              msg.body ?? "",
              msg.senderAgentId ?? null,
              msg.actionTargetAgentId ?? null,
              msg.replyToId ?? null,
            );
            const targets = new Set([
              ...audience.deliveredLeaderIds,
              ...audience.deliveredOtherIds,
            ]);
            if (!targets.has(agentId)) continue; // skip — not routed to this agent

            deliver({
              type: "message.created",
              roomId: msg.roomId,
              message: msg,
            });
          }
        }
      } catch (err: any) {
        writeSseEvent(res, {
          event: "error",
          data: { error: err?.message ?? String(err) },
        });
      }

      // Flush buffered live events (deduping against replay's cursor)
      replaying = false;
      for (const evt of buffered) deliver(evt);
      buffered.length = 0;

      // --- Cleanup ---
      req.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
      res.on("error", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    },
  );

  return router;
}
