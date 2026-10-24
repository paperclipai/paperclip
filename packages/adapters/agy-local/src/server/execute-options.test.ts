import { describe, expect, it } from "vitest";
import { modelHasEffortSuffix, resolveAgyPrintTimeoutSec } from "./execute.js";

describe("modelHasEffortSuffix and resolveAgyPrintTimeoutSec", () => {
  it("modelHasEffortSuffix detects effort-suffixed model ids", () => {
    expect(modelHasEffortSuffix("gemini-3.6-flash-high")).toBe(true);
    expect(modelHasEffortSuffix("gemini-3.6-flash-medium")).toBe(true);
    expect(modelHasEffortSuffix("gpt-oss-120b-medium")).toBe(true);
    expect(modelHasEffortSuffix("auto")).toBe(false);
    expect(modelHasEffortSuffix("claude-sonnet-4-6")).toBe(false);
    expect(modelHasEffortSuffix("claude-opus-4-6-thinking")).toBe(false);
  });

  it("agy's print timeout stays under the Paperclip run timeout when resolved", () => {
    expect(resolveAgyPrintTimeoutSec(3600)).toBeLessThan(3600);
    expect(resolveAgyPrintTimeoutSec(3600)).toBe(3420);
    expect(resolveAgyPrintTimeoutSec(120)).toBe(110);
    expect(resolveAgyPrintTimeoutSec(10)).toBe(30);
    expect(resolveAgyPrintTimeoutSec(0)).toBe(0);
  });
});
