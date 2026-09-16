import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This test pins the published subpath surface of `package.json`.
//
// `@paperclipai/server` is itself a published npm package. Its published
// build imports `@paperclipai/adapter-utils/duplex-observability` as a real
// npm dependency, not as a workspace link. Node resolves that import against
// `publishConfig.exports`, so the subpath must stay published there. An
// earlier revision of this file denied the subpath with an explicit `null`
// entry; that denial broke module resolution for the published server. The
// subpath now falls through to the wildcard entry, the same as every other
// file in the package.

interface PackageManifest {
  exports: Record<string, unknown>;
  publishConfig: {
    exports: Record<string, unknown>;
  };
}

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

describe("publishConfig publishes the duplex observability subpath", () => {
  it("does not deny the subpath in publishConfig.exports", () => {
    expect(manifest.publishConfig.exports).not.toHaveProperty("./duplex-observability");
  });

  it("keeps the wildcard entry in publishConfig.exports so the subpath resolves through it", () => {
    expect(manifest.publishConfig.exports["./*"]).toBeDefined();
  });

  it("keeps the top-level wildcard export unchanged", () => {
    expect(manifest.exports["./*"]).toBe("./src/*.ts");
  });
});
