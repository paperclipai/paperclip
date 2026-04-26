import { describe, expect, it } from "vitest";
import {
  companySkillSourceTypeSchema,
  companySkillTrustLevelSchema,
  companySkillCompatibilitySchema,
  companySkillSourceBadgeSchema,
  companySkillFileInventoryEntrySchema,
  companySkillImportSchema,
  companySkillCreateSchema,
  companySkillProjectScanRequestSchema,
  companySkillFileUpdateSchema,
} from "./company-skill.js";

describe("companySkillSourceTypeSchema", () => {
  it("accepts all valid source types", () => {
    for (const sourceType of ["local_path", "github", "url", "catalog", "skills_sh"]) {
      expect(companySkillSourceTypeSchema.safeParse(sourceType).success).toBe(true);
    }
  });

  it("rejects an invalid source type", () => {
    expect(companySkillSourceTypeSchema.safeParse("git").success).toBe(false);
  });
});

describe("companySkillTrustLevelSchema", () => {
  it("accepts all valid trust levels", () => {
    for (const trustLevel of ["markdown_only", "assets", "scripts_executables"]) {
      expect(companySkillTrustLevelSchema.safeParse(trustLevel).success).toBe(true);
    }
  });

  it("rejects an invalid trust level", () => {
    expect(companySkillTrustLevelSchema.safeParse("full").success).toBe(false);
  });
});

describe("companySkillCompatibilitySchema", () => {
  it("accepts all valid compatibility values", () => {
    for (const compat of ["compatible", "unknown", "invalid"]) {
      expect(companySkillCompatibilitySchema.safeParse(compat).success).toBe(true);
    }
  });

  it("rejects an invalid value", () => {
    expect(companySkillCompatibilitySchema.safeParse("outdated").success).toBe(false);
  });
});

describe("companySkillSourceBadgeSchema", () => {
  it("accepts all valid source badges", () => {
    for (const badge of ["paperclip", "github", "local", "url", "catalog", "skills_sh"]) {
      expect(companySkillSourceBadgeSchema.safeParse(badge).success).toBe(true);
    }
  });

  it("rejects an invalid badge", () => {
    expect(companySkillSourceBadgeSchema.safeParse("npm").success).toBe(false);
  });
});

describe("companySkillFileInventoryEntrySchema", () => {
  it("accepts a valid file entry", () => {
    expect(companySkillFileInventoryEntrySchema.safeParse({ path: "/skills/ts.md", kind: "skill" }).success).toBe(true);
  });

  it("accepts all valid kinds", () => {
    for (const kind of ["skill", "markdown", "reference", "script", "asset", "other"]) {
      expect(companySkillFileInventoryEntrySchema.safeParse({ path: "/f", kind }).success).toBe(true);
    }
  });

  it("rejects an empty path", () => {
    expect(companySkillFileInventoryEntrySchema.safeParse({ path: "", kind: "skill" }).success).toBe(false);
  });

  it("rejects an invalid kind", () => {
    expect(companySkillFileInventoryEntrySchema.safeParse({ path: "/f", kind: "config" }).success).toBe(false);
  });
});

describe("companySkillImportSchema", () => {
  it("accepts a valid source", () => {
    expect(companySkillImportSchema.safeParse({ source: "github:org/repo" }).success).toBe(true);
  });

  it("rejects an empty source", () => {
    expect(companySkillImportSchema.safeParse({ source: "" }).success).toBe(false);
  });
});

describe("companySkillCreateSchema", () => {
  it("accepts a minimal skill create", () => {
    expect(companySkillCreateSchema.safeParse({ name: "TypeScript Linter" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(companySkillCreateSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts optional slug, description, and markdown", () => {
    const result = companySkillCreateSchema.safeParse({
      name: "TypeScript Linter",
      slug: "typescript-linter",
      description: "A linting skill for TypeScript projects",
      markdown: "# TypeScript Linter\n\nThis skill lints TypeScript code.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null values for optional fields", () => {
    const result = companySkillCreateSchema.safeParse({
      name: "TS Linter",
      slug: null,
      description: null,
      markdown: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("companySkillProjectScanRequestSchema", () => {
  it("accepts an empty object", () => {
    expect(companySkillProjectScanRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts projectIds and workspaceIds as UUID arrays", () => {
    const result = companySkillProjectScanRequestSchema.safeParse({
      projectIds: ["00000000-0000-0000-0000-000000000001"],
      workspaceIds: ["00000000-0000-0000-0000-000000000002"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUIDs in projectIds", () => {
    expect(
      companySkillProjectScanRequestSchema.safeParse({ projectIds: ["not-uuid"] }).success,
    ).toBe(false);
  });
});

describe("companySkillFileUpdateSchema", () => {
  it("accepts a valid file update", () => {
    const result = companySkillFileUpdateSchema.safeParse({
      path: "/skills/typescript.md",
      content: "# Updated content",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty path", () => {
    expect(companySkillFileUpdateSchema.safeParse({ path: "", content: "x" }).success).toBe(false);
  });

  it("accepts empty content string", () => {
    expect(companySkillFileUpdateSchema.safeParse({ path: "/f", content: "" }).success).toBe(true);
  });
});
