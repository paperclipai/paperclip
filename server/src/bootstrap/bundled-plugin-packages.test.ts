import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_PACKAGES } from "./bundled-plugin-packages.js";

describe("BUNDLED_PLUGIN_PACKAGES", () => {
  it("includes the disabled-by-default Penstock connector", () => {
    expect(BUNDLED_PLUGIN_PACKAGES).toContain("@penstock/paperclip-plugin");
  });

  it("keeps startup-installed package names unique", () => {
    expect(new Set(BUNDLED_PLUGIN_PACKAGES).size).toBe(BUNDLED_PLUGIN_PACKAGES.length);
  });
});
