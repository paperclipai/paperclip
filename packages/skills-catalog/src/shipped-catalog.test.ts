import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills, resolveCatalogSkillRef } from "./index.js";
import type { CatalogSkill } from "./types.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/docs/doc-maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage",
  "paperclipai/bundled/paperclip-operations/task-planning",
  "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/software-development/github-pr-workflow",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/browser/agent-browser",
  "paperclipai/optional/content/release-announcement",
  "paperclipai/optional/product/design-critique",
];

describe("shipped skills catalog", () => {
  it("ships the expected bundled and optional skill set", () => {
    const bundledKeys = catalogSkills
      .filter((skill) => skill.kind === "bundled")
      .map((skill) => skill.key)
      .sort();
    const optionalKeys = catalogSkills
      .filter((skill) => skill.kind === "optional")
      .map((skill) => skill.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps every shipped skill markdown-only until a script-bearing skill clears security review", () => {
    const scriptBearing = catalogSkills.filter((skill) => skill.trustLevel !== "markdown_only");
    expect(scriptBearing, formatViolations("script-bearing skills require security review", scriptBearing)).toEqual([]);
  });

  it("populates browse/search-relevant fields for every shipped skill", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (skill.compatibility !== "compatible") {
        issues.push(`${skill.key} compatibility=${skill.compatibility}`);
      }
      if (!skill.description || skill.description.length < 40) {
        issues.push(`${skill.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (skill.recommendedForRoles.length === 0) {
        issues.push(`${skill.key} must list recommendedForRoles`);
      }
      if (skill.tags.length === 0) {
        issues.push(`${skill.key} must list tags`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical paperclipai keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      const expectedKey = `paperclipai/${skill.kind}/${skill.category}/${skill.slug}`;
      const expectedId = `paperclipai:${skill.kind}:${skill.category}:${skill.slug}`;
      if (skill.key !== expectedKey) violations.push(`${skill.key} should be ${expectedKey}`);
      if (skill.id !== expectedId) violations.push(`${skill.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/skills-catalog");
    expect(catalogSkills.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped skills by id, key, and unique slug", () => {
    const sample = catalogSkills.find((skill) => skill.key === "paperclipai/bundled/software-development/github-pr-workflow");
    expect(sample, "expected github-pr-workflow to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogSkillRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.slug)).toMatchObject({ key: sample.key });
  });
});

function formatViolations(label: string, skills: CatalogSkill[]) {
  if (skills.length === 0) return label;
  const detail = skills.map((skill) => `${skill.key} (${skill.trustLevel})`).join(", ");
  return `${label}: ${detail}`;
}
