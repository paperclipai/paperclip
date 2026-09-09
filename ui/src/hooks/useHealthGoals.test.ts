import { describe, it, expect } from "vitest";
import { buildHealthGoalsUrl } from "./useHealthGoals";

describe("buildHealthGoalsUrl", () => {
  it("encodes companyId into the URL", () => {
    expect(buildHealthGoalsUrl("abc-123")).toBe(
      "/health/goals?companyId=abc-123",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    expect(buildHealthGoalsUrl("co/id&x=1")).toBe(
      "/health/goals?companyId=co%2Fid%26x%3D1",
    );
  });

  it("returns correct base path", () => {
    const url = buildHealthGoalsUrl("cid");
    expect(url.startsWith("/health/goals")).toBe(true);
  });

  it("includes companyId query param", () => {
    const url = buildHealthGoalsUrl("my-company");
    expect(url).toContain("companyId=my-company");
  });
});
