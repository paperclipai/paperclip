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

  it("hard-blocks the first oversized raw-input run", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD,
      highRunCount: 1,
    })).toBe("block");
  });

  it("continues to block later oversized runs on the same task", () => {
    expect(decideHighInputTokenRunGuard({
      inputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD + 25_000,
      highRunCount: 2,
    })).toBe("block");
  });

  it("keeps cache reads in total accounting but does not use them for the raw-input hard ceiling", () => {
    const totalInputTokens = totalInputTokensIncludingCache({
      inputTokens: 105_209,
      cachedInputTokens: 3_294_208,
    });

    expect(totalInputTokens).toBe(3_399_417);
    expect(decideHighInputTokenRunGuard({
      inputTokens: 105_209,
      highRunCount: 1,
    })).toBe("none");
  });
});
