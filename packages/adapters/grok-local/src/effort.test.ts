import { describe, expect, it } from "vitest";
import { grokModelSupportsXhigh, resolveGrokCliModelId, resolveGrokReasoningEffort } from "./effort.js";

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

describe("resolveGrokCliModelId", () => {
  it("defaults empty ids to grok-4.6", () => {
    expect(resolveGrokCliModelId("")).toBe("grok-4.6");
    expect(resolveGrokCliModelId(null)).toBe("grok-4.6");
  });

  it("remaps the retired grok-build alias to grok-4.6", () => {
    expect(resolveGrokCliModelId("grok-build")).toBe("grok-4.6");
    expect(resolveGrokCliModelId("Grok-Build")).toBe("grok-4.6");
  });

  it("passes through current CLI model ids", () => {
    expect(resolveGrokCliModelId("grok-4.6")).toBe("grok-4.6");
    expect(resolveGrokCliModelId("grok-4.5")).toBe("grok-4.5");
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
