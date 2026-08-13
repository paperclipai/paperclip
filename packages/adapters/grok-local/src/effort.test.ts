import { describe, expect, it } from "vitest";
import { grokModelSupportsXhigh, resolveGrokReasoningEffort } from "./effort.js";

describe("grokModelSupportsXhigh", () => {
  it("treats empty model as grok-4.6", () => {
    expect(grokModelSupportsXhigh("")).toBe(true);
    expect(grokModelSupportsXhigh(null)).toBe(true);
  });

  it("allows xhigh on 4.6 and grok-build", () => {
    expect(grokModelSupportsXhigh("grok-4.6")).toBe(true);
    expect(grokModelSupportsXhigh("Grok-4.6")).toBe(true);
    expect(grokModelSupportsXhigh("grok-build")).toBe(true);
  });

  it("rejects xhigh on 4.5", () => {
    expect(grokModelSupportsXhigh("grok-4.5")).toBe(false);
    expect(grokModelSupportsXhigh("grok-4.5-preview")).toBe(false);
  });
});

describe("resolveGrokReasoningEffort", () => {
  it("passes xhigh through on 4.6", () => {
    expect(resolveGrokReasoningEffort("grok-4.6", "xhigh")).toBe("xhigh");
  });

  it("downgrades xhigh to high on 4.5", () => {
    expect(resolveGrokReasoningEffort("grok-4.5", "xhigh")).toBe("high");
  });

  it("leaves other efforts unchanged", () => {
    expect(resolveGrokReasoningEffort("grok-4.5", "high")).toBe("high");
    expect(resolveGrokReasoningEffort("grok-4.5", "low")).toBe("low");
    expect(resolveGrokReasoningEffort("grok-4.6", "")).toBe("");
  });
});
