import { describe, expect, it } from "vitest";
import {
  pluginHookManifestEntrySchema,
  pluginHooksDeclarationSchema,
  pluginManifestV1Schema,
  whenPredicateSchema,
} from "./plugin.js";

const baseManifest = {
  id: "acme.fast-action",
  apiVersion: 1 as const,
  version: "1.0.0",
  displayName: "Acme Fast Action",
  description: "Reference plugin to validate the hooks contract.",
  author: "Acme",
  categories: ["automation"] as const,
  capabilities: ["plugin.state.read"] as const,
  entrypoints: { worker: "dist/worker.js" },
};

describe("whenPredicateSchema", () => {
  it("accepts each leaf predicate", () => {
    expect(whenPredicateSchema.parse({ issueHasField: "fastAction" })).toEqual({
      issueHasField: "fastAction",
    });
    expect(
      whenPredicateSchema.parse({ issueFieldEquals: { field: "mode", value: "fast" } }),
    ).toEqual({ issueFieldEquals: { field: "mode", value: "fast" } });
    expect(whenPredicateSchema.parse({ agentRoleEquals: "engineer" })).toEqual({
      agentRoleEquals: "engineer",
    });
  });

  it("accepts composite predicates recursively", () => {
    const nested = {
      all: [
        { issueHasField: "fastAction" },
        {
          any: [
            { agentRoleEquals: "engineer" },
            { not: { issueFieldEquals: { field: "mode", value: "slow" } } },
          ],
        },
      ],
    };
    expect(whenPredicateSchema.parse(nested)).toEqual(nested);
  });

  it("rejects unknown predicate keys", () => {
    expect(() => whenPredicateSchema.parse({ unknown: true })).toThrow();
    expect(() => whenPredicateSchema.parse({})).toThrow();
  });
});

describe("pluginHookManifestEntrySchema", () => {
  it("allows an empty entry (defaults applied at runtime)", () => {
    expect(pluginHookManifestEntrySchema.parse({})).toEqual({});
  });

  it("accepts priority + when together", () => {
    const entry = {
      priority: 25,
      when: { issueFieldEquals: { field: "fastAction", value: true } },
    };
    expect(pluginHookManifestEntrySchema.parse(entry)).toEqual(entry);
  });

  it("rejects non-finite priority", () => {
    expect(() => pluginHookManifestEntrySchema.parse({ priority: Number.NaN })).toThrow();
    expect(() => pluginHookManifestEntrySchema.parse({ priority: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() => pluginHookManifestEntrySchema.parse({ foo: "bar" })).toThrow();
  });
});

describe("pluginHooksDeclarationSchema", () => {
  it("accepts an empty declaration", () => {
    expect(pluginHooksDeclarationSchema.parse({})).toEqual({});
  });

  it("accepts both kinds independently", () => {
    const decl = {
      wakePayloadTransformer: { priority: 10 },
      skillResolverTransformer: {
        when: { agentRoleEquals: "engineer" },
      },
    };
    expect(pluginHooksDeclarationSchema.parse(decl)).toEqual(decl);
  });
});

describe("pluginManifestV1Schema with hooks", () => {
  it("accepts a manifest without a hooks block (additive, optional)", () => {
    expect(() => pluginManifestV1Schema.parse(baseManifest)).not.toThrow();
  });

  it("accepts a manifest declaring both hook kinds", () => {
    const manifest = {
      ...baseManifest,
      hooks: {
        wakePayloadTransformer: {
          priority: 10,
          when: { issueHasField: "fastAction" },
        },
        skillResolverTransformer: {},
      },
    };
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.hooks?.wakePayloadTransformer?.priority).toBe(10);
    expect(parsed.hooks?.skillResolverTransformer).toEqual({});
  });

  it("rejects an unknown hook kind in the hooks block (strict)", () => {
    const manifest = {
      ...baseManifest,
      hooks: { unknownHook: { priority: 1 } },
    };
    expect(() => pluginManifestV1Schema.parse(manifest)).toThrow();
  });
});
