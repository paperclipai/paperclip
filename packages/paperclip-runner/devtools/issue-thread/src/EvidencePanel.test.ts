import { describe, expect, it } from "vitest";

import type { CapabilityEvidenceRunnerRecord } from "../../../src/issue-thread/types.js";
import { groupCapabilityRunnerEvents } from "./EvidencePanel.js";

function record(
  ordinal: number,
  event: string,
  turnId = "turn-1",
): CapabilityEvidenceRunnerRecord {
  return {
    id: `event-${ordinal}`,
    turnId,
    kind: "provider_event",
    ordinal,
    detail: `provider event · ${event}`,
    details: [{ label: "Event", value: event }],
  };
}

describe("Runner event grouping", () => {
  it("aggregates each delta category per turn at its first position", () => {
    const session: CapabilityEvidenceRunnerRecord = {
      id: "event-1",
      turnId: "turn-0",
      kind: "session",
      ordinal: 1,
      detail: "session · started",
      details: [{ label: "Action", value: "started" }],
    };
    const groups = groupCapabilityRunnerEvents([
      session,
      record(2, "assistant_delta"),
      record(3, "reasoning_delta"),
      record(4, "assistant_delta"),
      record(5, "assistant_delta", "turn-2"),
    ]);

    expect(groups.map((group) => [group.event, group.records.map((entry) => entry.ordinal)])).toEqual([
      [null, [1]],
      ["assistant_delta", [2, 4]],
      ["reasoning_delta", [3]],
      ["assistant_delta", [5]],
    ]);
  });

  it("leaves non-delta events individually expandable", () => {
    const groups = groupCapabilityRunnerEvents([
      record(1, "turn_started"),
      record(2, "tool_result"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.event === null && group.records.length === 1)).toBe(true);
  });
});
