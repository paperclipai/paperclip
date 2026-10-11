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
  const view = (costUsd: number | null | undefined, costRecords: number, costComplete = true) =>
    ({ costUsd, costComplete, costRecords });

  it("prefers the full-stream checkpoint sum when it is complete", () => {
    expect(mergeAccountingCost(view(0.5, 1), view(1.25, 3))).toBe(1.25);
  });

  it("fills the gap from control when the checkpoint saw no cost evidence", () => {
    expect(mergeAccountingCost(view(1.25, 1), view(null, 0))).toBe(1.25);
  });

  it("reports unknown when the full stream shows a cost is missing", () => {
    // An early unpriced step pushed out of capped control capture must not
    // let a later partial sum pose as the priced total.
    expect(mergeAccountingCost(view(0.5, 1), view(null, 2, false))).toBeNull();
    expect(mergeAccountingCost(view(0.5, 1), view(null, 2, false), 1)).toBeNull();
  });

  it("returns null when both sides are missing", () => {
    expect(mergeAccountingCost(view(null, 0), view(undefined, 0))).toBeNull();
  });

  describe("when redaction left checkpoint records unreadable", () => {
    it("takes the control sum when control parsed every record the stream carried", () => {
      // Step 1's counter matched a secret, so its display line was unparseable:
      // the checkpoint holds only step 2 (0.0025) while control holds both.
      expect(mergeAccountingCost(view(0.005, 2), view(0.0025, 1), 1)).toBe(0.005);
    });

    it("fills from control when every display record was unreadable", () => {
      expect(mergeAccountingCost(view(0.0025, 1), view(null, 0), 1)).toBe(0.0025);
    });

    it("reports unknown when capped control is missing a record too", () => {
      // Control kept only the later step; the earlier readable one fell out of
      // its capture, so neither view holds the whole stream.
      expect(mergeAccountingCost(view(0.0025, 1), view(0.0025, 1), 1)).toBeNull();
    });

    it("reports unknown when control is itself incomplete", () => {
      expect(mergeAccountingCost(view(0.005, 2, false), view(0.0025, 1), 1)).toBeNull();
    });

    it("reports unknown when control holds no cost evidence for the unreadable record", () => {
      expect(mergeAccountingCost(view(null, 2), view(0.0025, 1), 1)).toBeNull();
    });
  });
});
