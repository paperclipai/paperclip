import { describe, expect, it, vi } from "vitest";
import { createStreamBus } from "../services/stream-bus.js";
import {
  createRoomStreamBus,
  type RoomStreamEvent,
} from "../services/room-stream-bus.js";
import {
  createAgentStreamBus,
  type AgentStreamEvent,
} from "../services/agent-stream-bus.js";

const fakeMessage = (id: string, roomId: string) => ({
  id,
  roomId,
  companyId: "co-1",
  senderAgentId: null,
  senderUserId: "user-1",
  type: "text",
  body: "hello",
  attachments: null,
  actionPayload: null,
  actionStatus: null,
  actionTargetAgentId: null,
  actionResult: null,
  actionError: null,
  actionExecutedAt: null,
  actionExecutedByAgentId: null,
  actionExecutedByUserId: null,
  replyToId: null,
  createdAt: new Date("2026-04-08T00:00:00Z"),
});

describe("RoomStreamBus", () => {
  it("delivers message.created to subscribers of the matching roomId", () => {
    const bus = createRoomStreamBus();
    const received: RoomStreamEvent[] = [];
    bus.subscribe("room-1", (evt) => received.push(evt));

    bus.publish("room-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("message.created");
    if (received[0].type === "message.created") {
      expect(received[0].message.id).toBe("m-1");
    }
  });

  it("isolates events by roomId", () => {
    const bus = createRoomStreamBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("room-A", a);
    bus.subscribe("room-B", b);

    bus.publish("room-A", {
      type: "message.created",
      roomId: "room-A",
      message: fakeMessage("m-A", "room-A"),
    });

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("delivers participant.joined and participant.left", () => {
    const bus = createRoomStreamBus();
    const received: RoomStreamEvent[] = [];
    bus.subscribe("room-1", (evt) => received.push(evt));

    bus.publish("room-1", {
      type: "participant.joined",
      roomId: "room-1",
      participant: {
        id: "p-1",
        roomId: "room-1",
        companyId: "co-1",
        agentId: "a-1",
        userId: null,
        role: "member",
        joinedAt: new Date("2026-04-08T00:00:00Z"),
      },
    });
    bus.publish("room-1", {
      type: "participant.left",
      roomId: "room-1",
      participantId: "p-1",
    });

    expect(received.map((e) => e.type)).toEqual([
      "participant.joined",
      "participant.left",
    ]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createRoomStreamBus();
    const listener = vi.fn();
    const unsub = bus.subscribe("room-1", listener);

    bus.publish("room-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });
    unsub();
    bus.publish("room-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-2", "room-1"),
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("AgentStreamBus", () => {
  it("delivers message.created scoped by agentId", () => {
    const bus = createAgentStreamBus();
    const received: AgentStreamEvent[] = [];
    bus.subscribe("agent-1", (evt) => received.push(evt));

    bus.publish("agent-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });

    expect(received).toHaveLength(1);
  });

  it("isolates events by agentId", () => {
    const bus = createAgentStreamBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("agent-A", a);
    bus.subscribe("agent-B", b);

    bus.publish("agent-A", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("delivers membership.changed + instructions.updated", () => {
    const bus = createAgentStreamBus();
    const received: AgentStreamEvent[] = [];
    bus.subscribe("agent-1", (e) => received.push(e));

    bus.publish("agent-1", {
      type: "membership.changed",
      roomIds: ["room-A", "room-B"],
    });
    bus.publish("agent-1", { type: "instructions.updated" });

    expect(received.map((e) => e.type)).toEqual([
      "membership.changed",
      "instructions.updated",
    ]);
  });
});

describe("Shared StreamBus delegation", () => {
  it("room and agent buses can share the same underlying StreamBus instance", () => {
    const base = createStreamBus();
    const roomBus = createRoomStreamBus(base);
    const agentBus = createAgentStreamBus(base);

    const roomReceived: RoomStreamEvent[] = [];
    const agentReceived: AgentStreamEvent[] = [];
    roomBus.subscribe("room-1", (e) => roomReceived.push(e));
    agentBus.subscribe("agent-1", (e) => agentReceived.push(e));

    roomBus.publish("room-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });
    agentBus.publish("agent-1", {
      type: "message.created",
      roomId: "room-1",
      message: fakeMessage("m-1", "room-1"),
    });

    expect(roomReceived).toHaveLength(1);
    expect(agentReceived).toHaveLength(1);
    // Topics are isolated — room event does NOT leak to agent subscribers
    expect(agentReceived).toHaveLength(1);
  });

  it("different topics with the same key do not collide", () => {
    const base = createStreamBus();
    const roomBus = createRoomStreamBus(base);
    const agentBus = createAgentStreamBus(base);

    const roomListener = vi.fn();
    const agentListener = vi.fn();
    // Same key "same-id" on both topics
    roomBus.subscribe("same-id", roomListener);
    agentBus.subscribe("same-id", agentListener);

    roomBus.publish("same-id", {
      type: "message.created",
      roomId: "same-id",
      message: fakeMessage("m-1", "same-id"),
    });

    expect(roomListener).toHaveBeenCalledOnce();
    expect(agentListener).not.toHaveBeenCalled();
  });
});
