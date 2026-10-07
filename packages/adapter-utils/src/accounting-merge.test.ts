import { describe, expect, it } from "vitest";
import { mergeAccountingCost, mergeAccountingUsage } from "./accounting-merge.js";

describe("mergeAccountingUsage", () => {
  it("keeps control-derived usage when the checkpoint is emptied by redaction", () => {
    // A display counter matching a secret value is unparseable, so the
    // checkpoint totals stay zero while the sanitized control record stays
    // parseable. The override must not zero out the run's saved usage.
    const control = { inputTokens: 120, outputTokens: 45, cachedInputTokens: 30 };
    const checkpoint = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    expect(mergeAccountingUsage(control, checkpoint)).toEqual(control);
  });

  it("keeps checkpoint usage when the display capture is capped", () => {
    // The override's original purpose: the full-stream checkpoint is fuller
    // than capped control/stdout capture.
    const control = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    const checkpoint = { inputTokens: 120, outputTokens: 45, cachedInputTokens: 30 };
    expect(mergeAccountingUsage(control, checkpoint)).toEqual(checkpoint);
  });

  it("takes the element-wise maximum when each side misses different records", () => {
    const control = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5 };
    const checkpoint = { inputTokens: 20, outputTokens: 40, cachedInputTokens: 5 };
    expect(mergeAccountingUsage(control, checkpoint)).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 5,
    });
  });

  it("leaves identical totals unchanged", () => {
    const usage = { inputTokens: 7, outputTokens: 8, cachedInputTokens: 9 };
    expect(mergeAccountingUsage(usage, { ...usage })).toEqual(usage);
  });
});

describe("mergeAccountingCost", () => {
  it("keeps a known control cost when the checkpoint cost is missing", () => {
    expect(mergeAccountingCost(1.25, null)).toBe(1.25);
  });

  it("keeps a known checkpoint cost when the control cost is missing", () => {
    expect(mergeAccountingCost(null, 0.5)).toBe(0.5);
  });

  it("returns null when both sides are missing", () => {
    expect(mergeAccountingCost(null, undefined)).toBeNull();
  });

  it("takes the fuller cost when both sides report one", () => {
    expect(mergeAccountingCost(1.25, 0.5)).toBe(1.25);
  });
});
