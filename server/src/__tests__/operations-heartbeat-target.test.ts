import { describe, expect, it } from "vitest";
import {
  hasFalseCompleteRecoverySignal,
  selectReadyUnassignedCandidate,
} from "../services/operations-heartbeat-target.js";

describe("operations heartbeat target helpers", () => {
  it("treats succeeded runs without explicit truth as false-complete recovery signals", () => {
    expect(
      hasFalseCompleteRecoverySignal({
        runStatus: "succeeded",
        truthType: null,
      }),
    ).toBe(true);
  });

  it("does not treat succeeded runs with blocker truth as false-complete", () => {
    expect(
      hasFalseCompleteRecoverySignal({
        runStatus: "succeeded",
        truthType: "blocker",
      }),
    ).toBe(false);
  });

  it("prefers highest-priority ready unassigned work before recency", () => {
    const selected = selectReadyUnassignedCandidate([
      {
        id: "urgent",
        priority: "urgent",
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "low",
        priority: "low",
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);

    expect(selected?.id).toBe("urgent");
  });

  it("uses recency as the tiebreaker when priorities match", () => {
    const selected = selectReadyUnassignedCandidate([
      {
        id: "older",
        priority: "high",
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "newer",
        priority: "high",
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);

    expect(selected?.id).toBe("newer");
  });
});
