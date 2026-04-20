import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { templateRegistrySchema } from "../template-types.js";

describe("docs/templates/registry.json", () => {
  it("conforms to the schema", () => {
    const registryPath = fileURLToPath(
      new URL("../../../../docs/templates/registry.json", import.meta.url),
    );
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(() => templateRegistrySchema.parse(raw)).not.toThrow();
  });
});
