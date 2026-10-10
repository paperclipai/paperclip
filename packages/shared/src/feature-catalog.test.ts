import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FEATURE_TIERS,
  INSTANCE_FEATURE_CATALOG,
  INSTANCE_FEATURE_KEYS,
  buildFeatureCatalogArtifact,
  featureCatalogArtifactSchema,
  renderFeatureCatalogArtifact,
} from "./feature-catalog.js";
import { instanceExperimentalSettingsSchema } from "./validators/instance.js";

function schemaBooleanFlagKeys(): string[] {
  return Object.entries(instanceExperimentalSettingsSchema.shape)
    .filter(([, fieldSchema]) => {
      let current: z.ZodTypeAny = fieldSchema as z.ZodTypeAny;
      for (;;) {
        if (current instanceof z.ZodDefault) {
          current = current._def.innerType as z.ZodTypeAny;
        } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
          current = current.unwrap() as z.ZodTypeAny;
        } else {
          break;
        }
      }
      return current instanceof z.ZodBoolean;
    })
    .map(([key]) => key)
    .sort();
}

describe("INSTANCE_FEATURE_CATALOG", () => {
  it("covers exactly the boolean flag keys of the experimental settings schema", () => {
    expect([...INSTANCE_FEATURE_KEYS]).toEqual(schemaBooleanFlagKeys());
  });

  it("keeps selfHostedDefault in sync with the schema defaults", () => {
    const schemaDefaults = instanceExperimentalSettingsSchema.parse({});
    for (const key of INSTANCE_FEATURE_KEYS) {
      expect(INSTANCE_FEATURE_CATALOG[key].selfHostedDefault, key).toBe(schemaDefaults[key]);
    }
  });

  it("has a non-empty title, description, and valid tier for every flag", () => {
    for (const key of INSTANCE_FEATURE_KEYS) {
      const entry = INSTANCE_FEATURE_CATALOG[key];
      expect(entry.title.trim().length, key).toBeGreaterThan(0);
      expect(entry.description.trim().length, key).toBeGreaterThan(0);
      expect(FEATURE_TIERS, key).toContain(entry.tier);
    }
  });
});

describe("buildFeatureCatalogArtifact", () => {
  it("emits catalogVersion plus one tier entry per flag key", () => {
    const artifact = buildFeatureCatalogArtifact("2026.720.0");
    expect(artifact.catalogVersion).toBe("2026.720.0");
    expect(Object.keys(artifact.features)).toEqual([...INSTANCE_FEATURE_KEYS]);
    for (const key of INSTANCE_FEATURE_KEYS) {
      expect(artifact.features[key]).toEqual({ tier: INSTANCE_FEATURE_CATALOG[key].tier });
    }
  });

  it("produces output that validates against featureCatalogArtifactSchema", () => {
    const artifact = buildFeatureCatalogArtifact("2026.720.0");
    expect(featureCatalogArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it("rejects an empty catalogVersion", () => {
    expect(() => buildFeatureCatalogArtifact("")).toThrow(/catalogVersion/);
    expect(() => buildFeatureCatalogArtifact("   ")).toThrow(/catalogVersion/);
  });
});

describe("featureCatalogArtifactSchema", () => {
  it("rejects unknown top-level or per-feature properties", () => {
    const valid = buildFeatureCatalogArtifact("2026.720.0");
    expect(
      featureCatalogArtifactSchema.safeParse({ ...valid, extra: true }).success,
    ).toBe(false);
    expect(
      featureCatalogArtifactSchema.safeParse({
        catalogVersion: "2026.720.0",
        features: { enableApps: { tier: "managed", extra: true } },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown tiers and a missing catalogVersion", () => {
    expect(
      featureCatalogArtifactSchema.safeParse({
        catalogVersion: "2026.720.0",
        features: { enableApps: { tier: "mystery" } },
      }).success,
    ).toBe(false);
    expect(
      featureCatalogArtifactSchema.safeParse({ features: {} }).success,
    ).toBe(false);
  });
});

describe("renderFeatureCatalogArtifact", () => {
  it("is deterministic, sorted, and newline-terminated", () => {
    const rendered = renderFeatureCatalogArtifact("2026.720.0");
    expect(rendered).toBe(renderFeatureCatalogArtifact("2026.720.0"));
    expect(rendered.endsWith("\n")).toBe(true);
    const parsed = featureCatalogArtifactSchema.parse(JSON.parse(rendered));
    expect(Object.keys(parsed.features)).toEqual([...Object.keys(parsed.features)].sort());
    expect(parsed).toEqual(buildFeatureCatalogArtifact("2026.720.0"));
  });
});
