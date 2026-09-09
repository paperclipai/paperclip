import { describe, expect, it } from "vitest";
import { buildLabResultsUrl, LAB_MARKER_PRESETS } from "./useLabResults";

describe("buildLabResultsUrl", () => {
  it("builds the lab results URL with companyId, from, and to", () => {
    const url = buildLabResultsUrl("company-abc", "2025-09-01", "2026-09-01");
    expect(url).toBe(
      "/api/lab-results?companyId=company-abc&from=2025-09-01&to=2026-09-01",
    );
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildLabResultsUrl("company with spaces", "2025-09-01", "2026-09-01");
    expect(url).toContain("companyId=company%20with%20spaces");
  });

  it("uses /api/lab-results path", () => {
    const url = buildLabResultsUrl("company-abc", "2025-09-01", "2026-09-01");
    expect(url).toMatch(/^\/api\/lab-results\?/);
  });

  it("includes both from and to in the query string", () => {
    const url = buildLabResultsUrl("company-abc", "2025-09-01", "2026-09-01");
    expect(url).toContain("from=2025-09-01");
    expect(url).toContain("to=2026-09-01");
  });
});

describe("LAB_MARKER_PRESETS", () => {
  it("includes the 9 standard longevity biomarkers", () => {
    const names = LAB_MARKER_PRESETS.map((p) => p.name);
    expect(names).toContain("HbA1c");
    expect(names).toContain("Vitamin D (25-OH)");
    expect(names).toContain("hsCRP");
    expect(names).toContain("ApoB");
    expect(names).toContain("Testosterone");
    expect(names).toContain("IGF-1");
    expect(names).toContain("Ferritin");
    expect(names).toContain("Homocysteine");
    expect(names).toContain("eGFR");
    expect(LAB_MARKER_PRESETS).toHaveLength(9);
  });

  it("every preset has a non-empty loincCode and unit", () => {
    for (const preset of LAB_MARKER_PRESETS) {
      expect(preset.loincCode.length).toBeGreaterThan(0);
      expect(preset.unit.length).toBeGreaterThan(0);
    }
  });

  it("HbA1c has correct optimal range", () => {
    const hba1c = LAB_MARKER_PRESETS.find((p) => p.name === "HbA1c");
    expect(hba1c?.optimalMin).toBe(4.0);
    expect(hba1c?.optimalMax).toBe(5.6);
    expect(hba1c?.loincCode).toBe("4548-4");
  });

  it("eGFR has a lower bound but no upper bound", () => {
    const egfr = LAB_MARKER_PRESETS.find((p) => p.name === "eGFR");
    expect(egfr?.optimalMin).toBe(60);
    expect(egfr?.optimalMax).toBeNull();
  });
});
