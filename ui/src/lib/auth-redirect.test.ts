import { describe, expect, it } from "vitest";
import { buildAuthRedirectPath } from "./auth-redirect";

describe("buildAuthRedirectPath", () => {
  it("preserves the current pathname and search in the next parameter", () => {
    expect(buildAuthRedirectPath("/PAP/dashboard", "?tab=active&filter=mine")).toBe(
      "/auth?next=%2FPAP%2Fdashboard%3Ftab%3Dactive%26filter%3Dmine",
    );
  });

  it("handles routes without a search string", () => {
    expect(buildAuthRedirectPath("/issues/123")).toBe("/auth?next=%2Fissues%2F123");
  });
});
