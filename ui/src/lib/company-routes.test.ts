import { describe, expect, it } from "vitest";
import { applyCompanyPrefix, extractCompanyPrefixFromPath, toCompanyRelativePath } from "./company-routes";

describe("company route helpers", () => {
  it("prefixes knowledge routes like other board surfaces", () => {
    expect(applyCompanyPrefix("/knowledge", "EXE")).toBe("/EXE/knowledge");
  });

  it("does not mistake knowledge for a company prefix", () => {
    expect(extractCompanyPrefixFromPath("/knowledge")).toBeNull();
  });

  it("normalizes prefixed knowledge paths back to company-relative urls", () => {
    expect(toCompanyRelativePath("/EXE/knowledge?entry=abc")).toBe("/knowledge?entry=abc");
  });
});
