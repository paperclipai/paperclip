import { describe, expect, it } from "vitest";
import { buildIssuesSearchUrl } from "./Issues";

describe("buildIssuesSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug", "bug ")).toBe("/issues?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug#details", "")).toBe("/issues#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug+", "bug ")).toBeNull();
  });
});
