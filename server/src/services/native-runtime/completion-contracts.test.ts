import { describe, expect, it } from "vitest";

import { buildNativeCompletionContract } from "./completion-contracts.js";

describe("buildNativeCompletionContract", () => {
  it("uses the task description as the single initial criterion", () => {
    expect(buildNativeCompletionContract({
      title: "Ship the runner",
      description: "Prove the Codex vertical slice.",
    })).toEqual({
      revision: "1",
      objective: "Ship the runner",
      criteria: [{ id: "objective", requirement: "Prove the Codex vertical slice." }],
    });
  });

  it("binds the persisted numeric revision into the protocol contract", () => {
    expect(buildNativeCompletionContract({
      title: "Continue the runner",
      description: null,
    }, 3).revision).toBe("3");
  });
});
