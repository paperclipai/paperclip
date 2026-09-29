import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VENDORED_CORE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "vendor",
  "lifecycle-guard",
  "core.js",
);
// SON-4142 executed-byte pin for the lifecycle-guard core (see vendor PROVENANCE.md).
const PINNED_SHA256 =
  "746791a2b187bcf8d7c30b3540732813a88d01e3a69e90a3e52191f6bed3f492";

describe("vendored lifecycle-guard core", () => {
  it("is byte-identical to the pinned gateway plugin build", () => {
    const actual = createHash("sha256")
      .update(readFileSync(VENDORED_CORE))
      .digest("hex");
    expect(actual).toBe(PINNED_SHA256);
  });
});
