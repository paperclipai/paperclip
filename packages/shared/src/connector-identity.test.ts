import { describe, expect, it } from "vitest";
import { getAppDefinitionForApplicationKey } from "./connector-identity.js";

describe("saved connector identity", () => {
  it("resolves known catalog keys and company-scoped gallery keys", () => {
    expect(getAppDefinitionForApplicationKey("fireflies")?.slug).toBe("fireflies");
    expect(getAppDefinitionForApplicationKey("app-gallery:fireflies:44444444-4444-4444-8444-444444444444")?.slug).toBe("fireflies");
  });

  it.each([null, undefined, {}, "custom-mcp", "app-gallery:unknown:44444444-4444-4444-8444-444444444444", "app-gallery:fireflies:anything", "app-gallery:fireflies:44444444-4444-4444-8444-444444444444:extra", "fireflies.example.test"])("does not infer a catalog identity from %j", value => {
    expect(getAppDefinitionForApplicationKey(value)).toBeNull();
  });
});
