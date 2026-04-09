/**
 * Room-scoped SSE stream bus.
 *
 * Thin adapter over the generic StreamBus primitive (stream-bus.ts).
 * Publishes room lifecycle events (message created/updated, participant
 * joined/left) keyed by roomId.
 *
 * Used by:
 *   - SSE endpoints that stream room activity (admin views, debug tools)
 *   - Phase 4 leader CLI bridges (via agent-stream-bus fanout)
 *
 * @see docs/cos-v2/phase4-cli-design.md §7
 */

import { createStreamBus, type StreamBus } from "./stream-bus.js";

const ROOM_TOPIC = "room";

/** Runtime type of a stored room_messages row (loose — see drizzle schema). */
export interface RoomMessageLike {
  id: string;
  roomId: string;
  companyId: string;
  senderAgentId: string | null;
  senderUserId: string | null;
  type: string;
  body: string;
  attachments: unknown;
  actionPayload: unknown;
  actionStatus: string | null;
  actionTargetAgentId: string | null;
  actionResult: unknown;
  actionError: string | null;
  actionExecutedAt: Date | string | null;
  actionExecutedByAgentId: string | null;
  actionExecutedByUserId: string | null;
  approvalId: string | null;
  replyToId: string | null;
  createdAt: Date | string;
}

export interface RoomParticipantLike {
  id: string;
  roomId: string;
  companyId: string;
  agentId: string | null;
  userId: string | null;
  role: string;
  joinedAt: Date | string;
}

/**
 * Union of events published on the room bus. New variants can be added
 * without breaking existing subscribers thanks to the discriminated union.
 */
export type RoomStreamEvent =
  | { type: "message.created"; roomId: string; message: RoomMessageLike }
  | { type: "message.updated"; roomId: string; message: RoomMessageLike }
  | {
      type: "participant.joined";
      roomId: string;
      participant: RoomParticipantLike;
    }
  | { type: "participant.left"; roomId: string; participantId: string };

export interface RoomStreamBus {
  subscribe(
    roomId: string,
    listener: (event: RoomStreamEvent) => void,
  ): () => void;
  publish(roomId: string, event: RoomStreamEvent): void;
}

/**
 * Create a new RoomStreamBus.
 *
 * If a shared StreamBus is provided, the room bus delegates to it —
 * same primitive as PluginStreamBus / AgentStreamBus. Omit to construct
 * an isolated bus (typically for tests).
 */
export function createRoomStreamBus(
  base: StreamBus = createStreamBus(),
): RoomStreamBus {
  return {
    subscribe(roomId, listener) {
      return base.subscribe<RoomStreamEvent>(ROOM_TOPIC, roomId, (event) => {
        listener(event);
      });
    },
    publish(roomId, event) {
      base.publish<RoomStreamEvent>(ROOM_TOPIC, roomId, event, "message");
    },
  };
}
