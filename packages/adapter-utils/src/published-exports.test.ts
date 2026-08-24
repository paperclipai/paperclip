import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This test pins the published subpath surface of `package.json`. The package
// must deny the `duplex-observability` subpath in `publishConfig.exports`. An
// external import of the file stays internal to the package.

interface PackageManifest {
  exports: Record<string, unknown>;
  publishConfig: {
    exports: Record<string, unknown>;
  };
}

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

describe("publishConfig denies the duplex observability subpath", () => {
  it("maps the subpath to null in publishConfig.exports", () => {
    expect(manifest.publishConfig.exports["./duplex-observability"]).toBeNull();
  });

  it("keeps the wildcard entry in publishConfig.exports", () => {
    expect(manifest.publishConfig.exports["./*"]).toBeDefined();
  });

  it("keeps the top-level wildcard export unchanged", () => {
    expect(manifest.exports["./*"]).toBe("./src/*.ts");
  });
});
