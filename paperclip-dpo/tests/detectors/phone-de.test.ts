import { describe, it, expect } from "vitest";
import { detectPhonesDe } from "../../src/detectors/phone-de.js";

describe("detectPhonesDe", () => {
  it("findet +49-Format", () => {
    const f = detectPhonesDe("Tel: +49 30 12345678");
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("PHONE");
  });

  it("findet 0049-Format", () => {
    expect(detectPhonesDe("Ruf 0049 30 12345678 an")).toHaveLength(1);
  });

  it("findet 030-Format", () => {
    expect(detectPhonesDe("030 12345678")).toHaveLength(1);
  });

  it("findet 030-1234-5678 mit Bindestrichen", () => {
    expect(detectPhonesDe("030-1234-5678")).toHaveLength(1);
  });

  it("ignoriert reine Zahlen ohne Telefon-Form", () => {
    expect(detectPhonesDe("Bestellnummer 12345")).toEqual([]);
  });
});
