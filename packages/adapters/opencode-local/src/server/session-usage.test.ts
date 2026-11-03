import { describe, expect, it } from "vitest";
import {
  parseOpenCodeSessionTotals,
  subtractOpenCodeSessionTotals,
} from "./session-usage.js";

describe("parseOpenCodeSessionTotals", () => {
  it("reads the wrapped `opencode api` payload", () => {
    expect(
      parseOpenCodeSessionTotals(
        JSON.stringify({
          data: {
            cost: 0.0025,
            tokens: {
              input: 10,
              output: 2,
              reasoning: 1,
              cache: { read: 3, write: 4 },
            },
          },
        }),
      ),
    ).toEqual({
      usage: { inputTokens: 14, cachedInputTokens: 3, outputTokens: 3 },
      costUsd: 0.0025,
    });
  });

  it("accepts a bare session object and treats missing optional counters as zero", () => {
    expect(
      parseOpenCodeSessionTotals(
        JSON.stringify({
          cost: 0,
          tokens: { input: 5, output: 1, cache: { read: 2 } },
        }),
      ),
    ).toEqual({
      usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 1 },
      costUsd: 0,
    });
  });

  it.each([
    "",
    "not json",
    JSON.stringify({ data: {} }),
    JSON.stringify({ data: { tokens: { input: 1 } } }),
    JSON.stringify({ data: { tokens: { input: -1, output: 2 } } }),
    JSON.stringify({ data: { tokens: { input: 1, output: 2, cache: { read: -1 } } } }),
  ])("rejects an incomplete payload %j", (raw) => {
    expect(parseOpenCodeSessionTotals(raw)).toBeNull();
  });
});

describe("subtractOpenCodeSessionTotals", () => {
  it("reports the run delta for a resumed session", () => {
    expect(
      subtractOpenCodeSessionTotals(
        {
          usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 },
          costUsd: 0.5,
        },
        {
          usage: { inputTokens: 40, cachedInputTokens: 5, outputTokens: 10 },
          costUsd: 0.2,
        },
      ),
    ).toEqual({
      usage: { inputTokens: 60, cachedInputTokens: 15, outputTokens: 20 },
      costUsd: 0.3,
    });
  });

  it("clamps at zero if the session was reset", () => {
    expect(
      subtractOpenCodeSessionTotals(
        {
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
          costUsd: 0.1,
        },
        {
          usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 5 },
          costUsd: 0.4,
        },
      ),
    ).toEqual({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    });
  });

  it("returns the totals when there is no baseline", () => {
    const totals = {
      usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 },
      costUsd: null,
    };
    expect(subtractOpenCodeSessionTotals(totals, null)).toEqual(totals);
  });
});
