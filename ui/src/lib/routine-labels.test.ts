import { describe, expect, it } from "vitest";
import {
  ROUTINE_CONCURRENCY_POLICY_DESCRIPTIONS,
  ROUTINE_CONCURRENCY_POLICY_LABELS,
  formatRoutineLastResultLabel,
  formatRoutineRunStatusLabel,
} from "./routine-labels";

describe("routine labels", () => {
  it("shows a friendly label for coalesced routine runs", () => {
    expect(formatRoutineRunStatusLabel("coalesced")).toBe("Added to Active Run");
  });

  it("shows a friendly label for coalesced routine trigger results", () => {
    expect(formatRoutineLastResultLabel("Coalesced into an existing live execution issue")).toBe(
      "Added to active run",
    );
  });

  it("shows friendly concurrency policy labels", () => {
    expect(ROUTINE_CONCURRENCY_POLICY_LABELS.coalesce_if_active).toBe("Reuse Active Run");
    expect(ROUTINE_CONCURRENCY_POLICY_DESCRIPTIONS.coalesce_if_active).toBe(
      "If a run is already in progress, add this trigger to the existing run instead of creating a new issue.",
    );
  });
});
