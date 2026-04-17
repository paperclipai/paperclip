import { describe, it, expect } from "vitest";
import { extractLegacyPlanBody } from "./documents.js";

// ---------------------------------------------------------------------------
// extractLegacyPlanBody
// ---------------------------------------------------------------------------

describe("extractLegacyPlanBody", () => {
  it("returns null for null input", () => {
    expect(extractLegacyPlanBody(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractLegacyPlanBody(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractLegacyPlanBody("")).toBeNull();
  });

  it("returns null when no <plan> tag is present", () => {
    expect(extractLegacyPlanBody("This is just a description with no plan tag.")).toBeNull();
  });

  it("extracts the body from a <plan>...</plan> block", () => {
    const input = "Some text\n<plan>\nDo something\n</plan>\nMore text";
    expect(extractLegacyPlanBody(input)).toBe("Do something");
  });

  it("trims leading and trailing whitespace from the extracted body", () => {
    const input = "<plan>  \n  Trimmed body  \n  </plan>";
    expect(extractLegacyPlanBody(input)).toBe("Trimmed body");
  });

  it("handles multiline plan bodies", () => {
    const input = "<plan>\nStep 1\nStep 2\nStep 3\n</plan>";
    expect(extractLegacyPlanBody(input)).toBe("Step 1\nStep 2\nStep 3");
  });

  it("is case-insensitive for the plan tag", () => {
    expect(extractLegacyPlanBody("<PLAN>body</PLAN>")).toBe("body");
    expect(extractLegacyPlanBody("<Plan>body</Plan>")).toBe("body");
  });

  it("returns null when <plan> tag is present but body is empty after trimming", () => {
    expect(extractLegacyPlanBody("<plan>   </plan>")).toBeNull();
  });

  it("matches only the first <plan> block when multiple are present", () => {
    const input = "<plan>first</plan> and <plan>second</plan>";
    expect(extractLegacyPlanBody(input)).toBe("first");
  });
});
