import { describe, expect, it } from "vitest";
import { adapterRegistrySchema } from "./adapter-registry.js";

describe("adapterRegistrySchema", () => {
  it("parses a full entry", () => {
    const parsed = adapterRegistrySchema.parse([
      {
        adapterType: "opencode_local",
        runtimeImage: "ghcr.io/paperclipai/runtime-opencode:v1",
        envKeys: ["ANTHROPIC_API_KEY"],
        allowFqdns: [],
        probeCommand: ["opencode", "--version"],
        defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost.bifrost.svc.cluster.local:8080" },
      },
    ]);
    expect(parsed[0].adapterType).toBe("opencode_local");
    expect(parsed[0].enabled).toBe(true); // defaulted
    expect(parsed[0].defaultEnv?.ANTHROPIC_BASE_URL).toContain("bifrost");
  });

  it("defaults enabled to true and optional collections to undefined", () => {
    const parsed = adapterRegistrySchema.parse([{ adapterType: "pi_local" }]);
    expect(parsed[0]).toMatchObject({ adapterType: "pi_local", enabled: true });
    expect(parsed[0].runtimeImage).toBeUndefined();
  });

  it("rejects an entry with no adapterType", () => {
    expect(() => adapterRegistrySchema.parse([{ enabled: true }])).toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => adapterRegistrySchema.parse({ adapterType: "x" })).toThrow();
  });
});
