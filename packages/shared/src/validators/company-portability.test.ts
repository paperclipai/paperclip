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

// ---------------------------------------------------------------------------
// portabilityIncludeSchema
// ---------------------------------------------------------------------------

describe("portabilityIncludeSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(portabilityIncludeSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an object with all boolean fields set", () => {
    const result = portabilityIncludeSchema.safeParse({
      company: true,
      agents: true,
      projects: false,
      issues: false,
      skills: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when a field has a non-boolean value", () => {
    expect(portabilityIncludeSchema.safeParse({ company: "yes" }).success).toBe(false);
  });

  it("accepts partial include (some fields set, some absent)", () => {
    expect(portabilityIncludeSchema.safeParse({ agents: true }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// portabilityEnvInputSchema
// ---------------------------------------------------------------------------

describe("portabilityEnvInputSchema", () => {
  const VALID_ENV_INPUT = {
    key: "API_KEY",
    description: "API key for the service",
    agentSlug: null,
    projectSlug: null,
    kind: "secret",
    requirement: "required",
    defaultValue: null,
    portability: "portable",
  };

  it("accepts a valid env input", () => {
    expect(portabilityEnvInputSchema.safeParse(VALID_ENV_INPUT).success).toBe(true);
  });

  it("rejects when key is empty", () => {
    expect(portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, key: "" }).success).toBe(false);
  });

  it("rejects an invalid kind value", () => {
    expect(portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, kind: "encrypted" }).success).toBe(false);
  });

  it("accepts kind 'plain'", () => {
    expect(portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, kind: "plain" }).success).toBe(true);
  });

  it("rejects an invalid requirement value", () => {
    expect(
      portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, requirement: "recommended" }).success,
    ).toBe(false);
  });

  it("accepts requirement 'optional'", () => {
    expect(
      portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, requirement: "optional" }).success,
    ).toBe(true);
  });

  it("rejects an invalid portability value", () => {
    expect(
      portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, portability: "global" }).success,
    ).toBe(false);
  });

  it("accepts portability 'system_dependent'", () => {
    expect(
      portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, portability: "system_dependent" }).success,
    ).toBe(true);
  });

  it("accepts a non-null defaultValue string", () => {
    expect(
      portabilityEnvInputSchema.safeParse({ ...VALID_ENV_INPUT, defaultValue: "default" }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// portabilityFileEntrySchema
// ---------------------------------------------------------------------------

describe("portabilityFileEntrySchema", () => {
  it("accepts a plain string file entry", () => {
    expect(portabilityFileEntrySchema.safeParse("file content here").success).toBe(true);
  });

  it("accepts a base64 encoded file entry object", () => {
    expect(
      portabilityFileEntrySchema.safeParse({ encoding: "base64", data: "SGVsbG8=" }).success,
    ).toBe(true);
  });

  it("accepts a base64 entry with a contentType", () => {
    expect(
      portabilityFileEntrySchema.safeParse({
        encoding: "base64",
        data: "SGVsbG8=",
        contentType: "image/png",
      }).success,
    ).toBe(true);
  });

  it("rejects an object with an unknown encoding", () => {
    expect(
      portabilityFileEntrySchema.safeParse({ encoding: "utf8", data: "hello" }).success,
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(portabilityFileEntrySchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// portabilityCollisionStrategySchema
// ---------------------------------------------------------------------------

describe("portabilityCollisionStrategySchema", () => {
  it("accepts 'rename'", () => {
    expect(portabilityCollisionStrategySchema.safeParse("rename").success).toBe(true);
  });

  it("accepts 'skip'", () => {
    expect(portabilityCollisionStrategySchema.safeParse("skip").success).toBe(true);
  });

  it("accepts 'replace'", () => {
    expect(portabilityCollisionStrategySchema.safeParse("replace").success).toBe(true);
  });

  it("rejects an unknown strategy", () => {
    expect(portabilityCollisionStrategySchema.safeParse("merge").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// portabilitySourceSchema
// ---------------------------------------------------------------------------

describe("portabilitySourceSchema", () => {
  it("accepts a github source", () => {
    const result = portabilitySourceSchema.safeParse({
      type: "github",
      url: "https://github.com/acme/repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a github source with a non-URL", () => {
    const result = portabilitySourceSchema.safeParse({
      type: "github",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an inline source with files", () => {
    const result = portabilitySourceSchema.safeParse({
      type: "inline",
      files: { "COMPANY.md": "company content" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an inline source with base64 file entries", () => {
    const result = portabilitySourceSchema.safeParse({
      type: "inline",
      files: { "logo.png": { encoding: "base64", data: "abc==" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown source type", () => {
    expect(portabilitySourceSchema.safeParse({ type: "s3", bucket: "my-bucket" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// portabilityTargetSchema
// ---------------------------------------------------------------------------

describe("portabilityTargetSchema", () => {
  it("accepts a new_company target", () => {
    expect(
      portabilityTargetSchema.safeParse({ mode: "new_company" }).success,
    ).toBe(true);
  });

  it("accepts a new_company target with an optional name", () => {
    expect(
      portabilityTargetSchema.safeParse({ mode: "new_company", newCompanyName: "Acme" }).success,
    ).toBe(true);
  });

  it("accepts an existing_company target with a valid UUID", () => {
    expect(
      portabilityTargetSchema.safeParse({
        mode: "existing_company",
        companyId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(true);
  });

  it("rejects existing_company with an invalid UUID", () => {
    expect(
      portabilityTargetSchema.safeParse({
        mode: "existing_company",
        companyId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(portabilityTargetSchema.safeParse({ mode: "clone" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// portabilityAgentSelectionSchema
// ---------------------------------------------------------------------------

describe("portabilityAgentSelectionSchema", () => {
  it("accepts the literal 'all'", () => {
    expect(portabilityAgentSelectionSchema.safeParse("all").success).toBe(true);
  });

  it("accepts an array of agent slug strings", () => {
    expect(portabilityAgentSelectionSchema.safeParse(["cto", "pm"]).success).toBe(true);
  });

  it("rejects an empty array item (empty string)", () => {
    expect(portabilityAgentSelectionSchema.safeParse([""]).success).toBe(false);
  });

  it("rejects a non-'all' string", () => {
    expect(portabilityAgentSelectionSchema.safeParse("none").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// companyPortabilityExportSchema
// ---------------------------------------------------------------------------

describe("companyPortabilityExportSchema", () => {
  it("accepts an empty export request", () => {
    expect(companyPortabilityExportSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an export request with include", () => {
    expect(
      companyPortabilityExportSchema.safeParse({ include: { agents: true } }).success,
    ).toBe(true);
  });

  it("accepts an export request with agent slug filter", () => {
    expect(
      companyPortabilityExportSchema.safeParse({ agents: ["cto"] }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// companyPortabilityPreviewSchema
// ---------------------------------------------------------------------------

describe("companyPortabilityPreviewSchema", () => {
  const VALID_PREVIEW = {
    source: { type: "github", url: "https://github.com/acme/repo" },
    target: { mode: "new_company" },
  };

  it("accepts a minimal valid preview request", () => {
    expect(companyPortabilityPreviewSchema.safeParse(VALID_PREVIEW).success).toBe(true);
  });

  it("accepts a preview with include and collision strategy", () => {
    expect(
      companyPortabilityPreviewSchema.safeParse({
        ...VALID_PREVIEW,
        include: { agents: true },
        collisionStrategy: "skip",
      }).success,
    ).toBe(true);
  });

  it("rejects when source is missing", () => {
    expect(
      companyPortabilityPreviewSchema.safeParse({ target: { mode: "new_company" } }).success,
    ).toBe(false);
  });

  it("rejects when target is missing", () => {
    expect(
      companyPortabilityPreviewSchema.safeParse({
        source: { type: "github", url: "https://github.com/acme/repo" },
      }).success,
    ).toBe(false);
  });
});
