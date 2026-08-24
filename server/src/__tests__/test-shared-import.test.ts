import { describe, expect, it } from "vitest";
import { FEATURE_KEYS } from "@paperclipai/shared";

describe("shared import test", () => {
  it("can import from @paperclipai/shared", () => {
    expect(FEATURE_KEYS.UNLIMITED_SEATS).toBe("unlimited_seats");
  });
});
