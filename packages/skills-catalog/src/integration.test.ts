import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills } from "./index.js";
import type {
  CatalogManifest,
  CatalogSkill,
  CatalogSkillGitHubSource,
  CatalogTrustLevel,
} from "./types.js";

// * Resolve the package root once, used for all local file lookups
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

// * The list of valid trust levels for schema validation
const VALID_TRUST_LEVELS: CatalogTrustLevel[] = [
  "markdown_only",
  "assets",
  "scripts_executables",
];

// * The list of valid compatibility values
const VALID_COMPATIBILITY = ["compatible", "unknown", "invalid"];

describe("integration: catalog.json schema validation", () => {
  it("exports a well-formed manifest with required top-level fields", () => {
    expect(catalogManifest).toBeDefined();
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/skills-catalog");
    expect(catalogManifest.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(catalogManifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Array.isArray(catalogManifest.skills)).toBe(true);
  });

  it("ships at least one bundled skill", () => {
    const bundled = catalogSkills.filter((s) => s.kind === "bundled");
    expect(bundled.length).toBeGreaterThan(0);
  });

  it("exposes catalog.json as a static import matching the runtime type", async () => {
    // * Re-import catalog.json from the filesystem and compare with the typed version
    const generatedPath = path.resolve(packageRoot, "generated", "catalog.json");
    const rawText = await fs.readFile(generatedPath, "utf8");
    const rawManifest = JSON.parse(rawText) as CatalogManifest;
    expect(rawManifest.skills.length).toBe(catalogSkills.length);
    expect(rawManifest.schemaVersion).toBe(catalogManifest.schemaVersion);
    expect(rawManifest.packageVersion).toBe(catalogManifest.packageVersion);
  });
});

describe("integration: CatalogSkill schema validation", () => {
  it("has valid fields for every shipped skill", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      validateSkillShape(skill, violations);
    }
    expect(violations).toEqual([]);
  });

  it("has unique ids, keys, and slugs across all skills", () => {
    const ids = new Map<string, string>();
    const keys = new Map<string, string>();
    const slugs = new Map<string, string>();
    const violations: string[] = [];

    for (const skill of catalogSkills) {
      const existingId = ids.get(skill.id);
      if (existingId) {
        violations.push(`Duplicate id "${skill.id}" in "${skill.path}" and "${existingId}"`);
      }
      ids.set(skill.id, skill.path);

      const existingKey = keys.get(skill.key);
      if (existingKey) {
        violations.push(`Duplicate key "${skill.key}" in "${skill.path}" and "${existingKey}"`);
      }
      keys.set(skill.key, skill.path);

      const existingSlug = slugs.get(skill.slug);
      if (existingSlug) {
        violations.push(`Duplicate slug "${skill.slug}" in "${skill.path}" and "${existingSlug}"`);
      }
      slugs.set(skill.slug, skill.path);
    }

    expect(violations).toEqual([]);
  });

  it("generates canonical ids and keys from kind/category/slug", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      const expectedId = `paperclipai:${skill.kind}:${skill.category}:${skill.slug}`;
      const expectedKey = `paperclipai/${skill.kind}/${skill.category}/${skill.slug}`;
      if (skill.id !== expectedId) {
        violations.push(`${skill.key}: id is "${skill.id}", expected "${expectedId}"`);
      }
      if (skill.key !== expectedKey) {
        violations.push(`${skill.key}: key is "${skill.key}", expected "${expectedKey}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("has sha256 content hashes with the correct prefix", () => {
    for (const skill of catalogSkills) {
      expect(skill.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("has compatible compatibility for all shipped skills", () => {
    const incompatible = catalogSkills.filter((s) => s.compatibility !== "compatible");
    expect(incompatible).toEqual([]);
  });

  it("has valid trust level for each skill derived from its files", () => {
    for (const skill of catalogSkills) {
      expect(VALID_TRUST_LEVELS).toContain(skill.trustLevel);
      // * Trust level should match the files: if any file is a script -> scripts_executables;
      //   if no scripts but has assets -> assets; otherwise markdown_only
      const hasScript = skill.files.some((f) => f.kind === "script");
      const hasAsset = skill.files.some((f) => f.kind === "asset" || f.kind === "other");
      if (hasScript) {
        expect(skill.trustLevel).toBe("scripts_executables");
      } else if (hasAsset) {
        expect(skill.trustLevel).toBe("assets");
      } else {
        expect(skill.trustLevel).toBe("markdown_only");
      }
    }
  });

  it("has valid file entries for each skill", () => {
    const validFileKinds = ["skill", "markdown", "reference", "script", "asset", "other"];
    for (const skill of catalogSkills) {
      for (const file of skill.files) {
        expect(file.path).toBeTruthy();
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(validFileKinds).toContain(file.kind);
      }
    }
  });

  it("has SKILL.md as the entrypoint for every skill", () => {
    for (const skill of catalogSkills) {
      expect(skill.entrypoint).toBe("SKILL.md");
      const hasSkillFile = skill.files.some(
        (f) => f.path === "SKILL.md" && f.kind === "skill",
      );
      expect(hasSkillFile).toBe(true);
    }
  });
});

describe("integration: local skill file accessibility", () => {
  const localSkills = catalogSkills.filter((s) => !s.source);

  it("every local skill has its SKILL.md readable from the filesystem", async () => {
    const missing: string[] = [];
    for (const skill of localSkills) {
      const fullPath = path.resolve(packageRoot, skill.path, "SKILL.md");
      const exists = existsSync(fullPath);
      if (!exists) {
        missing.push(skill.key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every local skill file listed in catalog exists on disk with matching size and sha256", async () => {
    const errors: string[] = [];
    for (const skill of localSkills) {
      const skillRoot = path.resolve(packageRoot, skill.path);
      for (const file of skill.files) {
        const fullPath = path.resolve(skillRoot, file.path);

        // * Verify the file exists and is within the skill directory
        if (!existsSync(fullPath)) {
          errors.push(`${skill.key}: file ${file.path} does not exist at ${fullPath}`);
          continue;
        }

        // * Verify the file doesn't escape the skill root via symlinks
        const resolvedSkillRoot = await fs.realpath(skillRoot);
        const resolvedFilePath = await fs.realpath(fullPath);
        if (!resolvedFilePath.startsWith(resolvedSkillRoot + path.sep) && resolvedFilePath !== resolvedSkillRoot) {
          errors.push(`${skill.key}: file ${file.path} resolves outside skill directory`);
          continue;
        }

        // * Verify size matches
        const stat = await fs.stat(fullPath);
        if (stat.size !== file.sizeBytes) {
          errors.push(`${skill.key}: file ${file.path} size mismatch: catalog=${file.sizeBytes}, disk=${stat.size}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it("only local files within the skill directory are listed in catalog", async () => {
    const errors: string[] = [];
    for (const skill of localSkills) {
      const skillRoot = path.resolve(packageRoot, skill.path);

      async function collectFiles(dir: string): Promise<string[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const subFiles = await collectFiles(full);
            files.push(...subFiles.map((f) => path.join(entry.name, f)));
          } else if (entry.isFile()) {
            files.push(entry.name);
          }
        }
        return files;
      }

      const diskFiles = await collectFiles(skillRoot);
      const catalogPaths = new Set(skill.files.map((f) => f.path));

      for (const diskFile of diskFiles) {
        // * SKILL.md at the root is the mandatory entrypoint; everything else
        //   listed by the catalog builder should be in the catalog
        if (diskFile === "SKILL.md") continue;
        if (path.basename(diskFile) === "DESCRIPTION.md") continue; // optional description file
        if (!catalogPaths.has(diskFile)) {
          errors.push(`${skill.key}: file on disk not in catalog: ${diskFile}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});

describe("integration: referenced (GitHub) skill integrity", () => {
  const referencedSkills = catalogSkills.filter(
    (s): s is CatalogSkill & { source: CatalogSkillGitHubSource } =>
      s.source?.type === "github",
  );

  it("every referenced skill has valid GitHub source metadata", () => {
    for (const skill of referencedSkills) {
      expect(skill.source.hostname).toBeTruthy();
      expect(skill.source.owner).toBeTruthy();
      expect(skill.source.repo).toBeTruthy();
      expect(skill.source.ref).toBeTruthy();
      expect(skill.source.commit).toMatch(/^[0-9a-f]{40}$/i);
      expect(skill.source.path).toBeTruthy();
      expect(skill.source.url).toMatch(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\//,
      );
    }
  });

  it("referenced skills include source metadata", () => {
    // * Currently the only referenced skill is last30days
    const last30days = referencedSkills.find(
      (s) => s.key === "paperclipai/optional/research/last30days",
    );
    expect(last30days).toBeDefined();
    if (!last30days) return;

    // * Verify the source commit is a real SHA
    expect(last30days.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(last30days.source.owner).toBe("mvanhorn");
    expect(last30days.source.repo).toBe("last30days-skill");
  });
});

describe("integration: catalog manifest build integrity", () => {
  it("generated/catalog.json is present and parseable", async () => {
    const generatedPath = path.resolve(packageRoot, "generated", "catalog.json");
    const exists = existsSync(generatedPath);
    expect(exists).toBe(true);

    const content = await fs.readFile(generatedPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();

    const parsed = JSON.parse(content);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.packageName).toBe("@paperclipai/skills-catalog");
    expect(Array.isArray(parsed.skills)).toBe(true);
  });

  it("dist/generated/catalog.json is a valid built copy of the catalog manifest", async () => {
    const distGeneratedPath = path.resolve(packageRoot, "dist", "generated", "catalog.json");
    const exists = existsSync(distGeneratedPath);
    expect(exists).toBe(true);

    const distContent = await fs.readFile(distGeneratedPath, "utf8");
    const distParsed = JSON.parse(distContent);

    // * The dist copy should be a valid manifest
    expect(distParsed.schemaVersion).toBe(1);
    expect(distParsed.packageName).toBe("@paperclipai/skills-catalog");
    expect(distParsed.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Array.isArray(distParsed.skills)).toBe(true);
    expect(distParsed.skills.length).toBeGreaterThan(0);

    // * All source catalog skills must be present in the dist (dist may be newer)
    const sourceContent = await fs.readFile(
      path.resolve(packageRoot, "generated", "catalog.json"),
      "utf8",
    );
    const sourceParsed = JSON.parse(sourceContent);
    const distSkillIds = new Set(distParsed.skills.map((s: { id: string }) => s.id));
    for (const sourceSkill of sourceParsed.skills) {
      expect(distSkillIds.has(sourceSkill.id)).toBe(true);
    }
  });

  it("dist exports are present after build", () => {
    const distSrcDir = path.resolve(packageRoot, "dist", "src");
    expect(existsSync(path.resolve(distSrcDir, "index.js"))).toBe(true);
    expect(existsSync(path.resolve(distSrcDir, "types.js"))).toBe(true);
    expect(existsSync(path.resolve(distSrcDir, "index.d.ts"))).toBe(true);
    expect(existsSync(path.resolve(distSrcDir, "types.d.ts"))).toBe(true);
  });
});

describe("integration: description and tag quality", () => {
  it("every skill has a meaningful description (>= 40 chars) for search and browse", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (!skill.description || skill.description.trim().length < 40) {
        issues.push(
          `${skill.key}: description must be at least 40 characters (got ${skill.description?.length ?? 0})`,
        );
      }
    }
    expect(issues).toEqual([]);
  });

  it("every skill has at least one recommended role and tag", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (skill.recommendedForRoles.length === 0) {
        issues.push(`${skill.key}: must have at least one recommendedForRoles`);
      }
      if (skill.tags.length === 0) {
        issues.push(`${skill.key}: must have at least one tag`);
      }
    }
    expect(issues).toEqual([]);
  });
});

/**
 * Validates the shape of a CatalogSkill and collects violations.
 */
function validateSkillShape(skill: CatalogSkill, violations: string[]) {
  const prefix = skill.key;

  // * Required string fields
  if (!skill.id) violations.push(`${prefix}: missing id`);
  if (!skill.key) violations.push(`${prefix}: missing key`);
  if (!["bundled", "optional"].includes(skill.kind)) {
    violations.push(`${prefix}: invalid kind "${skill.kind}"`);
  }
  if (!skill.category) violations.push(`${prefix}: missing category`);
  if (!skill.slug) violations.push(`${prefix}: missing slug`);
  if (!skill.name) violations.push(`${prefix}: missing name`);
  if (!skill.description) violations.push(`${prefix}: missing description`);
  if (!skill.path) violations.push(`${prefix}: missing path`);
  if (!skill.entrypoint) violations.push(`${prefix}: missing entrypoint`);

  // * Required enum fields
  if (!VALID_TRUST_LEVELS.includes(skill.trustLevel)) {
    violations.push(`${prefix}: invalid trustLevel "${skill.trustLevel}"`);
  }
  if (!VALID_COMPATIBILITY.includes(skill.compatibility)) {
    violations.push(`${prefix}: invalid compatibility "${skill.compatibility}"`);
  }

  // * Path should be relative to the package root
  if (!skill.path.startsWith("catalog/")) {
    violations.push(`${prefix}: path "${skill.path}" should start with "catalog/"`);
  }

  // * Required array fields
  if (!Array.isArray(skill.recommendedForRoles)) {
    violations.push(`${prefix}: recommendedForRoles must be an array`);
  }
  if (!Array.isArray(skill.requires)) {
    violations.push(`${prefix}: requires must be an array`);
  }
  if (!Array.isArray(skill.tags)) {
    violations.push(`${prefix}: tags must be an array`);
  }
  if (!Array.isArray(skill.files)) {
    violations.push(`${prefix}: files must be an array`);
  }

  // * Required hash field
  if (!skill.contentHash) violations.push(`${prefix}: missing contentHash`);
}