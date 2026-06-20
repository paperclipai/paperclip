import { describe, expect, it } from "vitest";
import { MODEL_PROFILE_KEYS } from "../constants.js";

describe("MODEL_PROFILE_KEYS", () => {
  it("includes the built-in tiers", () => {
    expect(MODEL_PROFILE_KEYS).toEqual(["cheap", "deep", "bulk"]);
  });

  it("keeps cheap as the first/default known key", () => {
    expect(MODEL_PROFILE_KEYS[0]).toBe("cheap");
  });
});
