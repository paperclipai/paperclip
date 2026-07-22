import { describe, expect, it } from "vitest";
import { pendingInteractionTerminalConflict } from "./issue-thread-interaction-lifecycle.js";

describe("pendingInteractionTerminalConflict", () => {
  it("blocks a new terminal transition while a decision is pending", () => {
    expect(
      pendingInteractionTerminalConflict("in_review", "done", [
        { status: "pending" },
        { status: "accepted" },
      ]),
    ).toBe("Resolve or expire the pending decision before closing this task.");
  });

  it("allows non-terminal updates and resolved interactions", () => {
    expect(
      pendingInteractionTerminalConflict("in_review", "todo", [{ status: "pending" }]),
    ).toBeNull();
    expect(
      pendingInteractionTerminalConflict("in_review", "done", [{ status: "accepted" }]),
    ).toBeNull();
  });

  it("does not make legacy terminal tasks impossible to edit", () => {
    expect(
      pendingInteractionTerminalConflict("done", "done", [{ status: "pending" }]),
    ).toBeNull();
  });
});
