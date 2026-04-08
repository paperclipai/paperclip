/**
 * Agent-scoped SSE stream bus.
 *
 * Thin adapter over the generic StreamBus primitive (stream-bus.ts).
 * Publishes events relevant to a single agent — all room messages the
 * agent should see (derived from current room_participants membership)
 * plus membership/instructions changes that affect the agent's leader
 * CLI bridge.
 *
 * This is the primary bus that Phase 4 channel-bridge-cos subscribes to
 * via GET /api/companies/:cid/agents/:aid/stream. Agent-scoped keying
 * means adding/removing an agent from a room is picked up automatically
 * on the server side — no bridge restart required.
 *
 * @see docs/cos-v2/phase4-cli-design.md §7, §8
 */

import { createStreamBus, type StreamBus } from "./stream-bus.js";
import type { RoomMessageLike } from "./room-stream-bus.js";

const AGENT_TOPIC = "agent";

/**
 * Events delivered to a specific agent.
 *
 * `message.created` — a new room_messages row in any room the agent
 *   participates in. Sender is still included; the bridge filters
 *   self-sent messages to prevent loops.
 *
 * `message.updated` — action status / result transition (for pending
 *   action messages the agent is targeted by).
 *
 * `membership.changed` — the agent's participant set changed. Carries
 *   the NEW full list of rooms. The bridge does NOT need to restart —
 *   the server's subscription model already routes future messages to
 *   the correct rooms. This event exists so the bridge can update its
 *   `lastReceivedRoomId`/target resolution if it caches anything.
 *
 * `instructions.updated` — the agent's team-instructions markdown
 *   changed (team membership changed, etc.). Bridge can re-fetch and
 *   update its MCP `instructions:` field. MVP: just log; bridge does
 *   not re-inject instructions into a running Claude session yet.
 */
export type AgentStreamEvent =
  | {
      type: "message.created";
      roomId: string;
      message: RoomMessageLike;
    }
  | {
      type: "message.updated";
      roomId: string;
      message: RoomMessageLike;
    }
  | { type: "membership.changed"; roomIds: string[] }
  | { type: "instructions.updated" };

export interface AgentStreamBus {
  subscribe(
    agentId: string,
    listener: (event: AgentStreamEvent) => void,
  ): () => void;
  publish(agentId: string, event: AgentStreamEvent): void;
}

export function createAgentStreamBus(
  base: StreamBus = createStreamBus(),
): AgentStreamBus {
  return {
    subscribe(agentId, listener) {
      return base.subscribe<AgentStreamEvent>(AGENT_TOPIC, agentId, (event) => {
        listener(event);
      });
    },
    publish(agentId, event) {
      base.publish<AgentStreamEvent>(AGENT_TOPIC, agentId, event, "message");
    },
  };
}
