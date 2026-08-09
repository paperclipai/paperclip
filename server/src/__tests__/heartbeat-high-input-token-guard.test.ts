import { describe, expect, it } from "vitest";
import {
  decideHighInputTokenRunGuard,
  HIGH_INPUT_TOKEN_RUN_THRESHOLD,
} from "../services/heartbeat.js";

describe("high input-token run guard", () => {
  it("does not intervene below the per-task threshold", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD - 1,
      highRunCount: 0,
    })).toBe("none");
  });

  it("requires a split or route review for the first oversized run", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD,
      highRunCount: 1,
    })).toBe("review");
  });

  it("blocks the second oversized run on the same task", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD + 25_000,
      highRunCount: 2,
    })).toBe("block");
  });
});
