import { describe, it, expect } from "vitest";
import { detectPii } from "../src/pii-detector.js";

describe("detectPii", () => {
  it("findet alle Detektor-Kategorien gleichzeitig", () => {
    const text =
      "Max schreibt an max@whitestag.de, Tel +49 30 12345678, " +
      "Konto DE89370400440532013000, BIC COBADEFF, USt DE123456789, " +
      "StNr 21/815/08150, 03046 Cottbus, https://whitestag.de";
    const findings = detectPii(text);
    const types = new Set(findings.map((f) => f.type));
    expect(types).toContain("EMAIL");
    expect(types).toContain("PHONE");
    expect(types).toContain("IBAN");
    expect(types).toContain("BIC");
    expect(types).toContain("UST_ID");
    expect(types).toContain("STEUERNUMMER");
    expect(types).toContain("PLZ");
    expect(types).toContain("URL");
  });

  it("respektiert detect-Filter aus Regelwerk", () => {
    const text = "max@whitestag.de und https://whitestag.de";
    const findings = detectPii(text, { only: ["email"] });
    expect(findings.every((f) => f.type === "EMAIL")).toBe(true);
  });

  it("entfernt überlappende Treffer (längster gewinnt)", () => {
    const text = "DE89370400440532013000";
    const findings = detectPii(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("IBAN");
  });
});
