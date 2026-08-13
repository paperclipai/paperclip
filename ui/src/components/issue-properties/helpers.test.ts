import { describe, expect, it } from "vitest";
import { thinkingEffortOptionsFor } from "./helpers";

describe("thinkingEffortOptionsFor", () => {
  it("hides xhigh for grok-4.5", () => {
    const values = thinkingEffortOptionsFor("grok_local", "grok-4.5").map((option) => option.value);
    expect(values).toEqual(["", "high", "medium", "low"]);
  });

  it("shows xhigh for grok-4.6 and default model", () => {
    expect(thinkingEffortOptionsFor("grok_local", "grok-4.6").map((option) => option.value))
      .toContain("xhigh");
    expect(thinkingEffortOptionsFor("grok_local", "").map((option) => option.value))
      .toContain("xhigh");
  });
});
