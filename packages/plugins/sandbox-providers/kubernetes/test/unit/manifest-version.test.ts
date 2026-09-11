import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import manifest from "../../src/manifest.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

describe("plugin manifest", () => {
  // These drifted apart once already (package 0.1.0 vs manifest 0.1.0-alpha.1).
  // paperclip-server registers the plugin under the MANIFEST version, so a
  // disagreement makes the installed package and the registered plugin report
  // different versions to operators.
  it("declares the same version as package.json", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("carries no alpha labelling: the plugin no longer depends on an alpha API", () => {
    const surfaces = [
      manifest.displayName,
      manifest.description,
      manifest.version,
      ...manifest.environmentDrivers!.flatMap((driver) => [
        driver.displayName,
        driver.description,
        ...Object.values(
          (driver.configSchema as { properties?: Record<string, { description?: string }> })
            .properties ?? {},
        ).map((property) => property.description ?? ""),
      ]),
    ];
    for (const surface of surfaces) {
      // `v1alpha1` is the name of a Kubernetes API version the plugin can still
      // address, not a maturity claim about the plugin, so it is not stripped
      // from the copy — only from this check.
      const withoutApiVersionNames = String(surface).replaceAll("v1alpha1", "");
      expect(withoutApiVersionNames.toLowerCase()).not.toContain("alpha");
    }
  });
});
