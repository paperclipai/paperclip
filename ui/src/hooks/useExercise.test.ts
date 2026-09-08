import { describe, expect, it } from "vitest";
import { buildExerciseHistoryUrl } from "./useExercise";

describe("buildExerciseHistoryUrl", () => {
  it("builds the exercise history URL with companyId, from, and to", () => {
    const url = buildExerciseHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/exercise?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildExerciseHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/exercise path", () => {
    const url = buildExerciseHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/exercise\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildExerciseHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
