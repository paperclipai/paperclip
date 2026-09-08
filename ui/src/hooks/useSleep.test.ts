import { describe, expect, it } from "vitest";
import { buildSleepHistoryUrl } from "./useSleep";

describe("buildSleepHistoryUrl", () => {
  it("builds the sleep history URL with companyId, from, and to", () => {
    const url = buildSleepHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/sleep?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildSleepHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/sleep path", () => {
    const url = buildSleepHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/sleep\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildSleepHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
