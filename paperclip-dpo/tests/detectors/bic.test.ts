import { describe, it, expect } from "vitest";
import { detectBics } from "../../src/detectors/bic.js";

describe("detectBics", () => {
  it("findet 8-stelligen BIC", () => {
    expect(detectBics("BIC: COBADEFF")).toHaveLength(1);
  });

  it("findet 11-stelligen BIC", () => {
    expect(detectBics("COBADEFFXXX")).toHaveLength(1);
  });

  it("ignoriert zu kurze Strings", () => {
    expect(detectBics("ABC")).toEqual([]);
  });
});
