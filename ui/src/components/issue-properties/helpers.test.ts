// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ISSUE_THINKING_EFFORT_OPTIONS,
  thinkingEffortKeyFor,
  thinkingEffortOptionsFor,
  thinkingEffortValueFor,
} from "./helpers";

function values(options: readonly { value: string }[]) {
  return options.map((option) => option.value);
}

describe("thinkingEffortOptionsFor", () => {
  it("offers every CLI-supported effort level for claude_local", () => {
    expect(values(thinkingEffortOptionsFor("claude_local"))).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("leaves the codex_local and opencode_local levels unchanged", () => {
    expect(values(thinkingEffortOptionsFor("codex_local"))).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(values(thinkingEffortOptionsFor("opencode_local"))).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("falls back to the claude_local levels for an unknown or missing adapter", () => {
    expect(thinkingEffortOptionsFor("process")).toBe(ISSUE_THINKING_EFFORT_OPTIONS.claude_local);
    expect(thinkingEffortOptionsFor(null)).toBe(ISSUE_THINKING_EFFORT_OPTIONS.claude_local);
  });
});

describe("thinkingEffortKeyFor", () => {
  it("writes each adapter's own config key", () => {
    expect(thinkingEffortKeyFor("claude_local")).toBe("effort");
    expect(thinkingEffortKeyFor("codex_local")).toBe("modelReasoningEffort");
    expect(thinkingEffortKeyFor("opencode_local")).toBe("variant");
  });
});

describe("thinkingEffortValueFor", () => {
  it("reads a stored claude_local effort back, including the two new levels", () => {
    expect(thinkingEffortValueFor("claude_local", { effort: "xhigh" })).toBe("xhigh");
    expect(thinkingEffortValueFor("claude_local", { effort: "max" })).toBe("max");
  });

  it("returns an empty string when no effort is stored", () => {
    expect(thinkingEffortValueFor("claude_local", {})).toBe("");
  });

  it("reads the codex_local effort aliases in priority order", () => {
    expect(
      thinkingEffortValueFor("codex_local", { modelReasoningEffort: "high", effort: "low" }),
    ).toBe("high");
    expect(thinkingEffortValueFor("codex_local", { effort: "low" })).toBe("low");
    expect(thinkingEffortValueFor("opencode_local", { variant: "max" })).toBe("max");
  });
});
