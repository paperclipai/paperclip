import { describe, it, expect } from "vitest";
import { detectIbans } from "../../src/detectors/iban.js";

describe("detectIbans", () => {
  it("findet deutsche IBAN", () => {
    const f = detectIbans("Konto: DE89 3704 0044 0532 0130 00");
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("IBAN");
    expect(f[0].value.replace(/\s/g, "")).toBe("DE89370400440532013000");
  });

  it("findet IBAN ohne Leerzeichen", () => {
    expect(detectIbans("DE89370400440532013000")).toHaveLength(1);
  });

  it("findet österreichische IBAN", () => {
    expect(detectIbans("AT611904300234573201")).toHaveLength(1);
  });

  it("ignoriert zu kurze Strings", () => {
    expect(detectIbans("DE89")).toEqual([]);
  });
});
