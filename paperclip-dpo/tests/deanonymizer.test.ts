import { describe, it, expect } from "vitest";
import { deanonymizeText } from "../src/deanonymizer.js";
import type { MappingEntry } from "../src/types.js";

describe("deanonymizeText", () => {
  it("ersetzt Pseudonyme zurück durch Klartext", () => {
    const mappings: MappingEntry[] = [
      { pseudonym: "[PERSON_A]", plaintext: "Max", type: "PERSON" },
      { pseudonym: "[EMAIL_A]", plaintext: "max@whitestag.de", type: "EMAIL" },
    ];
    const text = "Bitte kontaktiere [PERSON_A] unter [EMAIL_A].";
    expect(deanonymizeText(text, mappings)).toBe(
      "Bitte kontaktiere Max unter max@whitestag.de.",
    );
  });

  it("ersetzt mehrfache Vorkommen desselben Pseudonyms", () => {
    const mappings: MappingEntry[] = [
      { pseudonym: "[PERSON_A]", plaintext: "Max", type: "PERSON" },
    ];
    expect(deanonymizeText("[PERSON_A] und [PERSON_A]", mappings)).toBe("Max und Max");
  });

  it("läßt Text ohne bekannte Pseudonyme unverändert", () => {
    expect(deanonymizeText("Kein Pseudonym hier.", [])).toBe("Kein Pseudonym hier.");
  });

  it("escaped reguläre Zeichen in Pseudonymen", () => {
    const mappings: MappingEntry[] = [
      { pseudonym: "[FIRMA_A]", plaintext: "WHITESTAG GmbH", type: "FIRMA" },
    ];
    expect(deanonymizeText("[FIRMA_A]", mappings)).toBe("WHITESTAG GmbH");
  });
});
