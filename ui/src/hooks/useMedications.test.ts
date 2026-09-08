import { describe, expect, it } from "vitest";
import { buildMedicationHistoryUrl } from "./useMedications";

describe("buildMedicationHistoryUrl", () => {
  it("builds the medication history URL with companyId, from, and to", () => {
    const url = buildMedicationHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/medications?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildMedicationHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/medications path", () => {
    const url = buildMedicationHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/medications\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildMedicationHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
