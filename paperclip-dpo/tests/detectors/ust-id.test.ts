import { describe, it, expect } from "vitest";
import { detectUstIds } from "../../src/detectors/ust-id.js";

describe("detectUstIds", () => {
  it("findet deutsche USt-IdNr.", () => {
    expect(detectUstIds("USt-IdNr: DE123456789")).toHaveLength(1);
  });

  it("findet österreichische USt-IdNr.", () => {
    expect(detectUstIds("ATU12345678")).toHaveLength(1);
  });

  it("ignoriert irrelevante Strings", () => {
    expect(detectUstIds("Hello world")).toEqual([]);
  });
});
