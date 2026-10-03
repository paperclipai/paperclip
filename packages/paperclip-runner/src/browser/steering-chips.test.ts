import { describe, expect, it } from "vitest";

import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  resolveSteeringChips,
  type ResolvableSteeringChip,
} from "./steering-chips.js";

function chip(
  id: string,
  status: ResolvableSteeringChip["status"],
  expectedTurnId = "turn-1",
  acknowledgementKey?: string,
  afterSourceSeq?: number,
): ResolvableSteeringChip & { id: string; text: string } {
  return {
    id,
    text: id,
    expectedTurnId,
    status,
    detail: null,
    ...(acknowledgementKey === undefined ? {} : { acknowledgementKey }),
    ...(afterSourceSeq === undefined ? {} : { afterSourceSeq }),
  };
}

function acknowledgement(sourceEventId: string, turnId: string, itemId: string, sourceSeq = 1): PrpEvent {
  return {
    sourceEventId,
    sourceSeq,
    turnId,
    itemId,
    eventType: "item.completed",
    payload: { kind: "steering_acknowledgement" },
  } as PrpEvent;
}

describe("resolveSteeringChips", () => {
  it("does not treat a later steer as accepted because an earlier chip already consumed that acknowledgement", () => {
    const events = [acknowledgement("event-1", "turn-1", "item-1")];
    const resolved = resolveSteeringChips(
      [
        chip("first", "acknowledged"),
        chip("second", "pending"),
      ],
      events,
    );

    expect(resolved[0]).toMatchObject({ status: "acknowledged", acknowledgementKey: "item-1" });
    expect(resolved[1]).toMatchObject({ id: "second", status: "pending" });
    expect(resolved[1].acknowledgementKey).toBeUndefined();
  });

  it("binds each pending chip to the next unused acknowledgement for its own turn", () => {
    const events = [
      acknowledgement("event-1", "turn-1", "item-1"),
      acknowledgement("event-2", "turn-2", "item-2"),
      acknowledgement("event-3", "turn-1", "item-3"),
    ];
    const resolved = resolveSteeringChips(
      [
        chip("older", "acknowledged", "turn-1", "item-1"),
        chip("same-turn", "pending", "turn-1"),
        chip("other-turn", "pending", "turn-2"),
      ],
      events,
    );

    expect(resolved.map((entry) => [entry.id, entry.status, entry.acknowledgementKey])).toEqual([
      ["older", "acknowledged", "item-1"],
      ["same-turn", "acknowledged", "item-3"],
      ["other-turn", "acknowledged", "item-2"],
    ]);
  });

  it("leaves a pending chip pending when the only acknowledgement belongs to another turn", () => {
    const resolved = resolveSteeringChips(
      [chip("waiting", "pending", "turn-2")],
      [acknowledgement("event-1", "turn-1", "item-1")],
    );

    expect(resolved).toEqual([chip("waiting", "pending", "turn-2")]);
  });

  it("does not give a new steer an acknowledgement that was already in the log", () => {
    const resolved = resolveSteeringChips(
      [
        chip("lost", "failed", "turn-1", undefined, 4),
        chip("next", "pending", "turn-1", undefined, 4),
      ],
      [acknowledgement("event-1", "turn-1", "item-1", 4)],
    );

    expect(resolved[0]).toMatchObject({ status: "failed" });
    expect(resolved[1]).toMatchObject({ status: "pending" });
    expect(resolved[1].acknowledgementKey).toBeUndefined();
  });

  it("binds a steer only to an acknowledgement that arrives after it was created", () => {
    const resolved = resolveSteeringChips(
      [chip("next", "pending", "turn-1", undefined, 4)],
      [
        acknowledgement("event-1", "turn-1", "item-1", 4),
        acknowledgement("event-2", "turn-1", "item-2", 5),
      ],
    );

    expect(resolved[0]).toMatchObject({ status: "acknowledged", acknowledgementKey: "item-2" });
  });
});
