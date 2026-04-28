import { describe, expect, it } from "vitest";
import { parseLinearIssueRef } from "../src/linear.js";

describe("parseLinearIssueRef", () => {
  it("parses uppercase identifier (TEAM-123)", () => {
    expect(parseLinearIssueRef("LUC-123")).toEqual({ identifier: "LUC-123" });
  });

  it("parses lowercase identifier and normalizes to uppercase", () => {
    expect(parseLinearIssueRef("luc-42")).toEqual({ identifier: "LUC-42" });
  });

  it("parses mixed-case identifier", () => {
    expect(parseLinearIssueRef("Luc-99")).toEqual({ identifier: "LUC-99" });
  });

  it("parses Linear URL with slug", () => {
    const url = "https://linear.app/lucitra/issue/LUC-340/domain-consolidation";
    expect(parseLinearIssueRef(url)).toEqual({ identifier: "LUC-340" });
  });

  it("parses Linear URL without slug", () => {
    const url = "https://linear.app/myteam/issue/PROJ-7";
    expect(parseLinearIssueRef(url)).toEqual({ identifier: "PROJ-7" });
  });

  it("returns null for plain text", () => {
    expect(parseLinearIssueRef("just some text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLinearIssueRef("")).toBeNull();
  });

  it("returns null for partial identifier (missing number)", () => {
    expect(parseLinearIssueRef("LUC-")).toBeNull();
  });

  it("returns null for number only", () => {
    expect(parseLinearIssueRef("123")).toBeNull();
  });

  it("returns null for URL without issue path", () => {
    expect(parseLinearIssueRef("https://linear.app/lucitra/settings")).toBeNull();
  });
});
