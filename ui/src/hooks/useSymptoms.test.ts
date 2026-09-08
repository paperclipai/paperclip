import { describe, expect, it } from "vitest";
import { buildSymptomHistoryUrl } from "./useSymptoms";

describe("buildSymptomHistoryUrl", () => {
  it("builds the symptom history URL with companyId, from, and to", () => {
    const url = buildSymptomHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/symptoms?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildSymptomHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/symptoms path", () => {
    const url = buildSymptomHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/symptoms\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildSymptomHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
