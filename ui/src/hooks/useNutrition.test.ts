import { describe, expect, it } from "vitest";
import { buildNutritionHistoryUrl } from "./useNutrition";

describe("buildNutritionHistoryUrl", () => {
  it("builds the nutrition history URL with companyId, from, and to", () => {
    const url = buildNutritionHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/nutrition?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildNutritionHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/nutrition path", () => {
    const url = buildNutritionHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/nutrition\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildNutritionHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
