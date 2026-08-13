import { describe, expect, it } from "vitest";
import { totalTrackedTokens } from "./utils";

describe("totalTrackedTokens", () => {
  it("includes cached input tokens in the displayed usage total", () => {
    expect(totalTrackedTokens({
      inputTokens: 2_930,
      cachedInputTokens: 70_400,
      outputTokens: 503,
    })).toBe(73_833);
  });
});
