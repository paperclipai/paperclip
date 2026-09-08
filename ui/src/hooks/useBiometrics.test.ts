import { describe, expect, it } from "vitest";
import { buildBiometricsHistoryUrl } from "./useBiometrics";

describe("buildBiometricsHistoryUrl", () => {
  it("builds the biometrics history URL with companyId, from, and to", () => {
    const url = buildBiometricsHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toBe(
      "/api/biometrics?companyId=company-abc&from=2026-09-01&to=2026-09-14",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildBiometricsHistoryUrl("company with spaces", "2026-09-01", "2026-09-14");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/biometrics path", () => {
    const url = buildBiometricsHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toMatch(/^\/api\/biometrics\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildBiometricsHistoryUrl("company-abc", "2026-09-01", "2026-09-14");
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-14");
  });
});
