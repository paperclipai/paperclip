import { describe, it, expect } from "vitest";
import {
  portabilityIncludeSchema,
  portabilityEnvInputSchema,
  portabilityFileEntrySchema,
  portabilityCollisionStrategySchema,
  portabilitySourceSchema,
  portabilityTargetSchema,
  portabilityAgentSelectionSchema,
  companyPortabilityExportSchema,
  companyPortabilityPreviewSchema,
} from "./company-portability.js";

// ============================================================================
// portabilityIncludeSchema
// ============================================================================

describe("portabilityIncludeSchema", () => {
  it("parses empty object (all optional)", () => {
    const result = portabilityIncludeSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts all include flags", () => {
    const result = portabilityIncludeSchema.parse({
      company: true,
      agents: false,
      projects: true,
      issues: false,
      skills: true,
    });
    expect(result.company).toBe(true);
    expect(result.agents).toBe(false);
  });
});

// ============================================================================
// portabilityEnvInputSchema
// ============================================================================

describe("portabilityEnvInputSchema", () => {
  const validBase = {
    key: "API_KEY",
    description: "The API key",
    agentSlug: null,
    projectSlug: null,
    kind: "secret",
    requirement: "required",
    defaultValue: null,
    portability: "portable",
  };

  it("parses a valid env input", () => {
    const result = portabilityEnvInputSchema.parse(validBase);
    expect(result.key).toBe("API_KEY");
    expect(result.kind).toBe("secret");
  });

  it("rejects empty key", () => {
    expect(() =>
      portabilityEnvInputSchema.parse({ ...validBase, key: "" })
    ).toThrow();
  });

  it("rejects invalid kind", () => {
    expect(() =>
      portabilityEnvInputSchema.parse({ ...validBase, kind: "encrypted" })
    ).toThrow();
  });

  it("rejects invalid portability", () => {
    expect(() =>
      portabilityEnvInputSchema.parse({ ...validBase, portability: "always" })
    ).toThrow();
  });

  it("accepts 'plain' kind", () => {
    const result = portabilityEnvInputSchema.parse({ ...validBase, kind: "plain" });
    expect(result.kind).toBe("plain");
  });

  it("accepts 'optional' requirement", () => {
    const result = portabilityEnvInputSchema.parse({ ...validBase, requirement: "optional" });
    expect(result.requirement).toBe("optional");
  });

  it("accepts 'system_dependent' portability", () => {
    const result = portabilityEnvInputSchema.parse({
      ...validBase,
      portability: "system_dependent",
    });
    expect(result.portability).toBe("system_dependent");
  });
});

// ============================================================================
// portabilityFileEntrySchema (union: string | base64 object)
// ============================================================================

describe("portabilityFileEntrySchema", () => {
  it("accepts a bare string (file content)", () => {
    const result = portabilityFileEntrySchema.parse("file content");
    expect(result).toBe("file content");
  });

  it("accepts a base64 object", () => {
    const result = portabilityFileEntrySchema.parse({
      encoding: "base64",
      data: "SGVsbG8gV29ybGQ=",
    });
    expect(result).toMatchObject({ encoding: "base64", data: "SGVsbG8gV29ybGQ=" });
  });

  it("accepts a base64 object with optional contentType", () => {
    const result = portabilityFileEntrySchema.parse({
      encoding: "base64",
      data: "abc",
      contentType: "image/png",
    });
    expect(result).toMatchObject({ contentType: "image/png" });
  });

  it("rejects a number", () => {
    expect(() => portabilityFileEntrySchema.parse(42)).toThrow();
  });

  it("rejects a base64 object with wrong encoding", () => {
    expect(() =>
      portabilityFileEntrySchema.parse({ encoding: "hex", data: "abc" })
    ).toThrow();
  });
});

// ============================================================================
// portabilityCollisionStrategySchema
// ============================================================================

describe("portabilityCollisionStrategySchema", () => {
  it("accepts 'rename'", () => {
    expect(portabilityCollisionStrategySchema.parse("rename")).toBe("rename");
  });

  it("accepts 'skip'", () => {
    expect(portabilityCollisionStrategySchema.parse("skip")).toBe("skip");
  });

  it("accepts 'replace'", () => {
    expect(portabilityCollisionStrategySchema.parse("replace")).toBe("replace");
  });

  it("rejects unknown strategies", () => {
    expect(() => portabilityCollisionStrategySchema.parse("merge")).toThrow();
  });
});

// ============================================================================
// portabilitySourceSchema (discriminated union)
// ============================================================================

describe("portabilitySourceSchema", () => {
  it("parses an inline source", () => {
    const result = portabilitySourceSchema.parse({
      type: "inline",
      files: {
        "CLAUDE.md": "content",
        "agent.json": { encoding: "base64", data: "e30=" },
      },
    });
    expect(result.type).toBe("inline");
  });

  it("parses a github source", () => {
    const result = portabilitySourceSchema.parse({
      type: "github",
      url: "https://github.com/acme/export",
    });
    expect(result.type).toBe("github");
    if (result.type === "github") {
      expect(result.url).toBe("https://github.com/acme/export");
    }
  });

  it("rejects github source with invalid URL", () => {
    expect(() =>
      portabilitySourceSchema.parse({ type: "github", url: "not-a-url" })
    ).toThrow();
  });

  it("rejects unknown source type", () => {
    expect(() =>
      portabilitySourceSchema.parse({ type: "s3", url: "s3://bucket" })
    ).toThrow();
  });
});

// ============================================================================
// portabilityTargetSchema (discriminated union)
// ============================================================================

describe("portabilityTargetSchema", () => {
  it("parses new_company target", () => {
    const result = portabilityTargetSchema.parse({ mode: "new_company" });
    expect(result.mode).toBe("new_company");
  });

  it("accepts optional newCompanyName", () => {
    const result = portabilityTargetSchema.parse({
      mode: "new_company",
      newCompanyName: "Acme Corp",
    });
    if (result.mode === "new_company") {
      expect(result.newCompanyName).toBe("Acme Corp");
    }
  });

  it("parses existing_company target with UUID", () => {
    const id = "00000000-0000-0000-0000-000000000008";
    const result = portabilityTargetSchema.parse({ mode: "existing_company", companyId: id });
    expect(result.mode).toBe("existing_company");
    if (result.mode === "existing_company") {
      expect(result.companyId).toBe(id);
    }
  });

  it("rejects existing_company with non-UUID companyId", () => {
    expect(() =>
      portabilityTargetSchema.parse({ mode: "existing_company", companyId: "not-uuid" })
    ).toThrow();
  });

  it("rejects unknown mode", () => {
    expect(() =>
      portabilityTargetSchema.parse({ mode: "temp_company" })
    ).toThrow();
  });
});

// ============================================================================
// portabilityAgentSelectionSchema (union: 'all' | string[])
// ============================================================================

describe("portabilityAgentSelectionSchema", () => {
  it("accepts the literal 'all'", () => {
    expect(portabilityAgentSelectionSchema.parse("all")).toBe("all");
  });

  it("accepts an array of agent slugs", () => {
    const result = portabilityAgentSelectionSchema.parse(["agent-a", "agent-b"]);
    expect(result).toEqual(["agent-a", "agent-b"]);
  });

  it("rejects an array with empty strings", () => {
    expect(() =>
      portabilityAgentSelectionSchema.parse(["agent-a", ""])
    ).toThrow();
  });

  it("rejects a non-'all' string", () => {
    expect(() => portabilityAgentSelectionSchema.parse("some")).toThrow();
  });
});

// ============================================================================
// companyPortabilityExportSchema
// ============================================================================

describe("companyPortabilityExportSchema", () => {
  it("parses an empty object (all optional)", () => {
    const result = companyPortabilityExportSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts arrays of agent/skill/project slugs", () => {
    const result = companyPortabilityExportSchema.parse({
      agents: ["my-agent"],
      skills: ["my-skill"],
      projects: ["proj-1"],
    });
    expect(result.agents).toEqual(["my-agent"]);
  });

  it("rejects empty slug strings", () => {
    expect(() =>
      companyPortabilityExportSchema.parse({ agents: [""] })
    ).toThrow();
  });
});

// ============================================================================
// companyPortabilityPreviewSchema
// ============================================================================

describe("companyPortabilityPreviewSchema", () => {
  const id = "00000000-0000-0000-0000-000000000009";
  const validBase = {
    source: { type: "inline", files: {} },
    target: { mode: "existing_company", companyId: id },
  };

  it("parses a valid preview", () => {
    const result = companyPortabilityPreviewSchema.parse(validBase);
    expect(result.source.type).toBe("inline");
    expect(result.target.mode).toBe("existing_company");
  });

  it("accepts optional agents selection", () => {
    const result = companyPortabilityPreviewSchema.parse({
      ...validBase,
      agents: "all",
    });
    expect(result.agents).toBe("all");
  });

  it("accepts optional collisionStrategy", () => {
    const result = companyPortabilityPreviewSchema.parse({
      ...validBase,
      collisionStrategy: "rename",
    });
    expect(result.collisionStrategy).toBe("rename");
  });

  it("rejects missing required source", () => {
    expect(() =>
      companyPortabilityPreviewSchema.parse({ target: validBase.target })
    ).toThrow();
  });

  it("rejects missing required target", () => {
    expect(() =>
      companyPortabilityPreviewSchema.parse({ source: validBase.source })
    ).toThrow();
  });
});
