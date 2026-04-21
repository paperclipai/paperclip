import { describe, it, expect } from "vitest";
import { anonymizeText } from "../src/anonymizer.js";
import type { Finding } from "../src/types.js";

describe("anonymizeText", () => {
  it("ersetzt einzelnes Finding durch Pseudonym", () => {
    const text = "Hallo max@whitestag.de";
    const findings: Finding[] = [
      { type: "EMAIL", value: "max@whitestag.de", start: 6, end: 22, confidence: "high", source: "regex" },
    ];
    const out = anonymizeText(text, findings);
    expect(out.text).toBe("Hallo [EMAIL_A]");
    expect(out.mappings).toHaveLength(1);
    expect(out.mappings[0]).toMatchObject({
      pseudonym: "[EMAIL_A]",
      plaintext: "max@whitestag.de",
      type: "EMAIL",
    });
  });

  it("vergibt konsistente Pseudonyme bei Wiederholung", () => {
    const text = "Max schreibt. Max antwortet.";
    const findings: Finding[] = [
      { type: "PERSON", value: "Max", start: 0, end: 3, confidence: "high", source: "llm" },
      { type: "PERSON", value: "Max", start: 14, end: 17, confidence: "high", source: "llm" },
    ];
    const out = anonymizeText(text, findings);
    expect(out.text).toBe("[PERSON_A] schreibt. [PERSON_A] antwortet.");
    expect(out.mappings).toHaveLength(1);
  });

  it("vergibt unterschiedliche Pseudonyme für verschiedene Werte gleichen Typs", () => {
    const text = "Max und Erna";
    const findings: Finding[] = [
      { type: "PERSON", value: "Max", start: 0, end: 3, confidence: "high", source: "llm" },
      { type: "PERSON", value: "Erna", start: 8, end: 12, confidence: "high", source: "llm" },
    ];
    const out = anonymizeText(text, findings);
    expect(out.text).toBe("[PERSON_A] und [PERSON_B]");
    expect(out.mappings).toHaveLength(2);
  });

  it("ersetzt Findings rechts-nach-links damit Spans gültig bleiben", () => {
    const text = "a@b.de c@d.de";
    const findings: Finding[] = [
      { type: "EMAIL", value: "a@b.de", start: 0, end: 6, confidence: "high", source: "regex" },
      { type: "EMAIL", value: "c@d.de", start: 7, end: 13, confidence: "high", source: "regex" },
    ];
    const out = anonymizeText(text, findings);
    expect(out.text).toBe("[EMAIL_A] [EMAIL_B]");
  });
});
