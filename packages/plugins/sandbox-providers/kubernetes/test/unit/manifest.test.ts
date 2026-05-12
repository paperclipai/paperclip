import { describe, it, expect } from "vitest";
import manifest from "../../src/manifest.js";

describe("manifest", () => {
  const configSchema = manifest.environmentDrivers[0]?.configSchema as {
    properties: Record<string, { const?: unknown; maxLength?: number; pattern?: string }>;
    anyOf: Array<{
      properties?: Record<string, { const?: unknown }>;
      required?: string[];
    }>;
  };

  it("keeps namespace inputs within the Kubernetes DNS label length limit", () => {
    expect(configSchema.properties.namespacePrefix.maxLength).toBe(20);
    expect(configSchema.properties.companySlug.maxLength).toBe(43);
  });

  it("requires real Kubernetes credentials instead of only inCluster key presence", () => {
    expect(configSchema.properties.kubeconfig.pattern).toBe("\\S");
    expect(configSchema.anyOf).toContainEqual({
      properties: { inCluster: { const: true } },
      required: ["inCluster"],
    });
    expect(configSchema.anyOf).toContainEqual({ required: ["kubeconfig"] });
  });
});
