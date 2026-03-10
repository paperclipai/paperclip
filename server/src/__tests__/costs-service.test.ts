import { describe, expect, it } from "vitest";
import { pricingStateForUsageRows } from "../services/costs.js";

describe("pricingStateForUsageRows", () => {
  it("returns exact when all token-bearing runs are priced", () => {
    expect(
      pricingStateForUsageRows([
        { usageJson: { inputTokens: 120, outputTokens: 40, costUsd: 0.02 } },
        { usageJson: { input_tokens: 30, output_tokens: 12, total_cost_usd: 0.01 } },
      ]),
    ).toBe("exact");
  });

  it("returns unpriced when token-bearing runs have no priceable cost", () => {
    expect(
      pricingStateForUsageRows([
        { usageJson: { inputTokens: 120, outputTokens: 40 } },
        { usageJson: { input_tokens: 30, output_tokens: 12, cached_input_tokens: 10 } },
      ]),
    ).toBe("unpriced");
  });

  it("returns estimated when priced and unpriced token runs are mixed", () => {
    expect(
      pricingStateForUsageRows([
        { usageJson: { inputTokens: 120, outputTokens: 40, costUsd: 0.02 } },
        { usageJson: { input_tokens: 30, output_tokens: 12 } },
      ]),
    ).toBe("estimated");
  });

  it("returns exact when there is no token usage to price", () => {
    expect(pricingStateForUsageRows([{ usageJson: null }])).toBe("exact");
  });
});
