import { describe, expect, it } from "vitest";
import {
  decideHighInputTokenRunGuard,
  HIGH_INPUT_TOKEN_RUN_THRESHOLD,
  totalInputTokensIncludingCache,
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

  it("counts cache-read context in the oversized-run threshold", () => {
    const totalInputTokens = totalInputTokensIncludingCache({
      inputTokens: 105_209,
      cachedInputTokens: 3_294_208,
    });

    expect(totalInputTokens).toBe(3_399_417);
    expect(decideHighInputTokenRunGuard({
      inputTokens: totalInputTokens,
      highRunCount: 1,
    })).toBe("review");
  });
});
