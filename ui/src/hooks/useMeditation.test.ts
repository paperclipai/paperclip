import { describe, it, expect } from "vitest";
import { buildMeditationHistoryUrl } from "./useMeditation";

describe("buildMeditationHistoryUrl", () => {
  it("builds the meditation history URL with companyId, from, and to", () => {
    const url = buildMeditationHistoryUrl("company-abc", "2026-09-01", "2026-09-09");
    expect(url).toBe("/api/meditation?companyId=company-abc&from=2026-09-01&to=2026-09-09");
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildMeditationHistoryUrl("co/id?x=1", "2026-01-01", "2026-01-31");
    expect(url).toContain(encodeURIComponent("co/id?x=1"));
  });

  it("uses /api/meditation path", () => {
    const url = buildMeditationHistoryUrl("c", "2026-01-01", "2026-01-01");
    expect(url.startsWith("/api/meditation")).toBe(true);
  });

  it("includes both from and to in the query string", () => {
    const url = buildMeditationHistoryUrl("c", "2026-06-01", "2026-06-30");
    expect(url).toContain("from=2026-06-01");
    expect(url).toContain("to=2026-06-30");
  });
});
