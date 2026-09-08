import { describe, expect, it } from "vitest";
import { buildMoodHistoryUrl } from "./useMood";

describe("buildMoodHistoryUrl", () => {
  it("builds the mood history URL with companyId, from, and to", () => {
    const url = buildMoodHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/mood?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildMoodHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/mood path", () => {
    const url = buildMoodHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/mood\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildMoodHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
