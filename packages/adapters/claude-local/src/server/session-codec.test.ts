import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("claude-local sessionCodec usageTotals", () => {
  it("keeps the session usage totals so the next resume can subtract them", () => {
    const usageTotals = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      totalCostUsd: 1.25,
      modelUsage: { "claude-sonnet": { inputTokens: 10, outputTokens: 2, costUSD: 1.25 } },
    };
    const params = { sessionId: usageTotals.sessionId, cwd: "/work", usageTotals };
    expect(sessionCodec.serialize(params)).toEqual(params);
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toEqual(params);
  });

  it("drops malformed totals", () => {
    expect(sessionCodec.serialize({ sessionId: "s1", usageTotals: { totalCostUsd: 3 } })).toEqual({ sessionId: "s1" });
  });
});
