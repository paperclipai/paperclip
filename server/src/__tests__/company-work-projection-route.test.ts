import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCompanyWorkProjectionJson } from "../services/company-work-projection.js";

describe("company work projection route", () => {
  it("uses RFC 8785-compatible UTF-8 canonical JSON for evidence digests", () => {
    const canonical = canonicalCompanyWorkProjectionJson({ z: 0, b: [3, true, null], a: "é" });
    expect(canonical).toBe('{"a":"é","b":[3,true,null],"z":0}');
    expect(createHash("sha256").update(canonical, "utf8").digest("hex"))
      .toBe("1ddc151ac0e74d66d6f122fe9e0d709f50340765cb97df5e047d3896c0adfb08");
  });

  it("matches the RFC 8785 number, escaping, Unicode, and key-order vectors", () => {
    const canonical = canonicalCompanyWorkProjectionJson({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    });
    expect(canonical).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );

    const propertyOrder = canonicalCompanyWorkProjectionJson({
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    });
    const expectedValueOrder = [
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ];
    expect(expectedValueOrder.map((value) => propertyOrder.indexOf(value)))
      .toEqual([...expectedValueOrder.map((value) => propertyOrder.indexOf(value))].sort((a, b) => a - b));
    expect(() => canonicalCompanyWorkProjectionJson("\ud800")).toThrow("lone Unicode surrogates");
  });
});
