import { describe, expect, it } from "vitest";
import { unreadSteeredMessageIds, type SteeringDeliveryEvent } from "./steering-delivery.js";

const ack = (turnId: string, id: string): SteeringDeliveryEvent =>
  ({ eventType: "item.completed", kind: "steering_acknowledgement", turnId, itemId: `${turnId}:steer:${id}` });
const userMessage = (turnId: string): SteeringDeliveryEvent => ({ eventType: "item.started", kind: "userMessage", turnId });

describe("unreadSteeredMessageIds", () => {
  it("keeps a steer the model never read before the restart", () => {
    expect(unreadSteeredMessageIds([userMessage("t1"), ack("t1", "c1"), { eventType: "turn.failed", turnId: "t1" }]))
      .toEqual(["c1"]);
  });

  it("treats the turn's own input as read, not a later steer", () => {
    // The initial input's userMessage precedes the acknowledgement.
    expect(unreadSteeredMessageIds([userMessage("t1"), { eventType: "item.started", kind: "agentMessage", turnId: "t1" }, ack("t1", "c1")]))
      .toEqual(["c1"]);
  });

  it("drops a steer once its userMessage item starts, oldest first", () => {
    expect(unreadSteeredMessageIds([userMessage("t1"), ack("t1", "c1"), ack("t1", "c2"), userMessage("t1")])).toEqual(["c2"]);
  });

  it("counts a steered userMessage reported before its acknowledgement as read", () => {
    expect(unreadSteeredMessageIds([userMessage("t1"), userMessage("t1"), ack("t1", "c1"), ack("t1", "c2")])).toEqual(["c2"]);
    // An early read belongs to its own turn only.
    expect(unreadSteeredMessageIds([userMessage("t1"), userMessage("t1"), { eventType: "turn.failed", turnId: "t1" },
      userMessage("t2"), ack("t2", "c3")])).toEqual(["c3"]);
  });

  it("counts every earlier steer as read when a later turn's input starts", () => {
    expect(unreadSteeredMessageIds([ack("t1", "c1"), ack("t1", "c2"), userMessage("t2"), ack("t2", "c3")]))
      .toEqual(["c3"]);
  });

  it("counts every steer as read once a turn completes", () => {
    expect(unreadSteeredMessageIds([ack("t1", "c1"), { eventType: "turn.completed", turnId: "t2" }])).toEqual([]);
  });

  it("delivers a message once even if its acknowledgement repeats", () => {
    expect(unreadSteeredMessageIds([ack("t1", "c1"), ack("t1", "c1")])).toEqual(["c1"]);
    expect(unreadSteeredMessageIds([userMessage("t1"), ack("t1", "c1"), userMessage("t1"), ack("t1", "c1")])).toEqual([]);
  });

  it("ignores acknowledgements without a message id", () => {
    expect(unreadSteeredMessageIds([{ eventType: "item.completed", kind: "steering_acknowledgement", turnId: "t1", itemId: "t1:other" }]))
      .toEqual([]);
  });
});
