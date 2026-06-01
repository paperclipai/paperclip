import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCatalogPackageMetadata, listCatalogSkills } from "../services/skills-catalog.js";

describe("skills-catalog module resolution", () => {
  it("resolves catalog manifest via require.resolve when @paperclipai/skills-catalog is installed", () => {
    const require = createRequire(import.meta.url);
    let resolvedPath: string | null = null;
    try {
      resolvedPath = require.resolve("@paperclipai/skills-catalog/generated/catalog.json");
    } catch {
      // Not installed as a node_module — monorepo fallback path applies
    }

    if (resolvedPath !== null) {
      expect(existsSync(resolvedPath)).toBe(true);
    } else {
      // Verify the monorepo fallback path exists
      const serviceDir = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(serviceDir, "../../..");
      const fallbackPath = path.join(repoRoot, "packages/skills-catalog/generated/catalog.json");
      expect(existsSync(fallbackPath)).toBe(true);
    }
  });

  it("getCatalogPackageMetadata() returns packageName and packageVersion without throwing", () => {
    const metadata = getCatalogPackageMetadata();
    expect(typeof metadata.packageName).toBe("string");
    expect(metadata.packageName.length).toBeGreaterThan(0);
    expect(typeof metadata.packageVersion).toBe("string");
    expect(metadata.packageVersion.length).toBeGreaterThan(0);
  });

  it("listCatalogSkills() returns at least one skill from the resolved manifest", () => {
    const skills = listCatalogSkills();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });
});
