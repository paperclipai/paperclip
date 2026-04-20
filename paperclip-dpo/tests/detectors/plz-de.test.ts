import { describe, it, expect } from "vitest";
import { detectPlzDe } from "../../src/detectors/plz-de.js";

describe("detectPlzDe", () => {
  it("findet PLZ vor Stadt", () => {
    const f = detectPlzDe("03046 Cottbus");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("03046");
  });

  it("ignoriert 5-stellige Zahlen ohne Stadtkontext", () => {
    expect(detectPlzDe("Bestellung 12345 von gestern")).toEqual([]);
  });

  it("findet PLZ in Adresse mit Komma", () => {
    expect(detectPlzDe("Musterstr. 1, 10115 Berlin")).toHaveLength(1);
  });
});
