import { describe, expect, it } from "vitest";
import { serverVersion } from "../version.js";

describe("serverVersion", () => {
  it("is a non-empty string", () => {
    expect(typeof serverVersion).toBe("string");
    expect(serverVersion.length).toBeGreaterThan(0);
  });

  it("matches semver format (x.y.z)", () => {
    // Allows pre-release suffixes like 1.2.3-beta.1
    expect(serverVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
