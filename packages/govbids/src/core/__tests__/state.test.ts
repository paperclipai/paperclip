import { describe, it, expect } from "vitest";
import { stateAbbrFromText, VALID_STATE_ABBRS } from "../state.js";

describe("stateAbbrFromText", () => {
  it("maps a bare state name to its abbreviation", () => {
    expect(stateAbbrFromText("Texas")).toBe("TX");
    expect(stateAbbrFromText("Oregon")).toBe("OR");
    expect(stateAbbrFromText("Pennsylvania")).toBe("PA");
  });

  it("extracts the state from a 'City, State' string", () => {
    expect(stateAbbrFromText("Hartford, Connecticut")).toBe("CT");
    expect(stateAbbrFromText("Oakland, California")).toBe("CA");
    expect(stateAbbrFromText("Oakland, Maryland")).toBe("MD");
    expect(stateAbbrFromText("Little Rock, Arkansas")).toBe("AR");
  });

  it("passes through an existing valid abbreviation", () => {
    expect(stateAbbrFromText("GA")).toBe("GA");
    expect(stateAbbrFromText("Newnan, GA")).toBe("GA");
  });

  it("handles DC and territories (in scope per US-4)", () => {
    expect(stateAbbrFromText("District of Columbia")).toBe("DC");
    expect(stateAbbrFromText("Guam")).toBe("GU");
    expect(stateAbbrFromText("Puerto Rico")).toBe("PR");
  });

  it("returns null for non-US / unidentifiable locations", () => {
    expect(stateAbbrFromText("United Nations")).toBeNull();
    expect(stateAbbrFromText("Ontario")).toBeNull();
    expect(stateAbbrFromText("")).toBeNull();
    expect(stateAbbrFromText(null)).toBeNull();
  });

  it("does not false-match a city that contains a non-state word", () => {
    // 'Union County' must not map to anything via the word 'Union'
    expect(stateAbbrFromText("Union County")).toBeNull();
  });

  it("every mapped value is a recognized abbreviation", () => {
    expect(stateAbbrFromText("Wyoming")).toBe("WY");
    expect(VALID_STATE_ABBRS.has("WY")).toBe(true);
    expect(VALID_STATE_ABBRS.size).toBeGreaterThanOrEqual(51);
  });
});
