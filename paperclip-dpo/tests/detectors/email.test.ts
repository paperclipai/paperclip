import { describe, it, expect } from "vitest";
import { detectEmails } from "../../src/detectors/email.js";

describe("detectEmails", () => {
  it("findet einzelne E-Mail-Adresse", () => {
    const text = "Bitte schreibe an max.mustermann@whitestag.de.";
    const findings = detectEmails(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: "EMAIL",
      value: "max.mustermann@whitestag.de",
      source: "regex",
      confidence: "high",
    });
  });

  it("findet mehrere E-Mails", () => {
    const text = "a@b.de und c@d.com";
    expect(detectEmails(text)).toHaveLength(2);
  });

  it("liefert leere Liste wenn keine Treffer", () => {
    expect(detectEmails("kein Inhalt")).toEqual([]);
  });

  it("liefert korrekte Spans", () => {
    const text = "X a@b.de Y";
    const f = detectEmails(text)[0];
    expect(text.slice(f.start, f.end)).toBe("a@b.de");
  });
});
