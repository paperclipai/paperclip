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
  it("prefers the full-stream checkpoint sum when it is complete", () => {
    expect(mergeAccountingCost(
      { costUsd: 0.5, costComplete: true },
      { costUsd: 1.25, costComplete: true },
    )).toBe(1.25);
  });

  it("fills the gap from control when the checkpoint saw no cost evidence", () => {
    // Display lines redacted away are invisible to the checkpoint while the
    // sanitized control record stays parseable.
    expect(mergeAccountingCost(
      { costUsd: 1.25, costComplete: true },
      { costUsd: null, costComplete: true },
    )).toBe(1.25);
  });

  it("reports unknown when the full stream shows a cost is missing", () => {
    // An early unpriced step pushed out of capped control capture must not
    // let a later partial sum pose as the priced total.
    expect(mergeAccountingCost(
      { costUsd: 0.5, costComplete: true },
      { costUsd: null, costComplete: false },
    )).toBeNull();
  });

  it("returns null when both sides are missing", () => {
    expect(mergeAccountingCost(
      { costUsd: null, costComplete: true },
      { costUsd: undefined, costComplete: true },
    )).toBeNull();
  });
});
