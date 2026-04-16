import { describe, it, expect } from "vitest";
import { templateRegistrySchema, type TemplateRegistry } from "../template-types.js";

describe("templateRegistrySchema", () => {
  it("accepts a valid registry", () => {
    const valid: TemplateRegistry = {
      version: 1,
      generated_at: "2026-04-16T14:00:00Z",
      source: "https://github.com/paperclipai/companies",
      companies: [
        {
          slug: "trail-of-bits-security",
          name: "Trail of Bits Security",
          description: "Security auditing",
          agents_count: 28,
          skills_count: 35,
          tags: ["security"],
          url: "https://github.com/paperclipai/companies/tree/main/trail-of-bits-security",
        },
      ],
    };
    expect(() => templateRegistrySchema.parse(valid)).not.toThrow();
  });

  it("rejects registry with invalid version", () => {
    expect(() => templateRegistrySchema.parse({ version: 0, companies: [] })).toThrow();
  });

  it("rejects company without slug", () => {
    const bad = { version: 1, generated_at: "2026-04-16T14:00:00Z", source: "x", companies: [{ name: "x" }] };
    expect(() => templateRegistrySchema.parse(bad)).toThrow();
  });
});
