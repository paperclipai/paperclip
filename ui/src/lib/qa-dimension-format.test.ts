import { describe, expect, it } from "vitest";
import { formatQaDimensionState } from "./qa-dimension-format";

describe("formatQaDimensionState", () => {
  it("renders docs impact na as explicit no-docs-change copy", () => {
    expect(formatQaDimensionState("docsImpact", "na")).toBe("No docs change");
  });

  it("keeps generic qa state labels for non-doc dimensions", () => {
    expect(formatQaDimensionState("testCoverage", "na")).toBe("N/A");
    expect(formatQaDimensionState("codeQuality", "pass")).toBe("PASS");
  });
});
