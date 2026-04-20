import { describe, it, expect } from "vitest";
import { detectBics } from "../../src/detectors/bic.js";

describe("detectBics", () => {
  it("findet 8-stelligen BIC mit BIC: Label", () => {
    const f = detectBics("BIC: COBADEFF");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("COBADEFF");
  });

  it("findet 11-stelligen BIC mit SWIFT Label", () => {
    const f = detectBics("SWIFT: COBADEFFXXX");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("COBADEFFXXX");
  });

  it("findet BIC mit SWIFT-BIC: Label", () => {
    expect(detectBics("SWIFT-BIC: HYVEDEMM")).toHaveLength(1);
  });

  it("ignoriert ALL-CAPS-Acronyme ohne Label (false positive prevention)", () => {
    expect(detectBics("WHITESTAGAI ist eine Marke")).toEqual([]);
  });

  it("ignoriert zu kurze Strings", () => {
    expect(detectBics("BIC: ABC")).toEqual([]);
  });

  it("liefert korrekte Spans (nur die BIC, ohne Label)", () => {
    const text = "BIC: COBADEFF rest";
    const f = detectBics(text)[0];
    expect(text.slice(f.start, f.end)).toBe("COBADEFF");
  });
});
