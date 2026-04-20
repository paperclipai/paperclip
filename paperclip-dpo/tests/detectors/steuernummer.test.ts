import { describe, it, expect } from "vitest";
import { detectSteuernummern } from "../../src/detectors/steuernummer.js";

describe("detectSteuernummern", () => {
  it("findet deutsche Steuernummer im Format XX/XXX/XXXXX", () => {
    expect(detectSteuernummern("StNr: 21/815/08150")).toHaveLength(1);
  });

  it("findet 11-stellige Steuer-Identifikationsnummer", () => {
    expect(detectSteuernummern("Ident: 12345678901")).toHaveLength(1);
  });

  it("ignoriert kurze Zahlen", () => {
    expect(detectSteuernummern("Nummer 12345")).toEqual([]);
  });
});
