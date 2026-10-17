import { describe, expect, it } from "vitest";
import { resolvePluginHostVersion } from "../plugin-host-version.js";

describe("resolvePluginHostVersion", () => {
  it("uses the detected server version by default", () => {
    expect(resolvePluginHostVersion(undefined, "2026.831.1")).toBe("2026.831.1");
  });

  it("preserves an explicit test or embedding override", () => {
    expect(resolvePluginHostVersion("1.2.3", "2026.831.1")).toBe("1.2.3");
  });
});
