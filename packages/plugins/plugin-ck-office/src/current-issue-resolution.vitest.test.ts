import { describe, expect, it } from "vitest";
import { selectCurrentIssueId } from "./tools.js";

describe("selectCurrentIssueId", () => {
  it("uses the authenticated heartbeat snapshot before a model-provided hint", () => {
    expect(
      selectCurrentIssueId({
        snapshotIssueId: "task-uuid",
        providedHint: "CK-316",
      }),
    ).toBe("task-uuid");
  });

  it("falls back to direct run context and then manual hints", () => {
    expect(selectCurrentIssueId({ runContextIssueId: "run-task" })).toBe("run-task");
    expect(selectCurrentIssueId({ providedHint: "manual-task" })).toBe("manual-task");
  });
});
