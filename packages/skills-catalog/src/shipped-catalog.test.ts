import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills, resolveCatalogSkillRef } from "./index.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/docs/doc-maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage",
  "paperclipai/bundled/paperclip-operations/reflection-coach",
  "paperclipai/bundled/paperclip-operations/summarize-status",
  "paperclipai/bundled/paperclip-operations/task-planning",
  "paperclipai/bundled/product/paperclip-capsules",
  "paperclipai/bundled/product/wireframe",
  "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/software-development/github-pr-workflow",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/browser/agent-browser",
  "paperclipai/optional/content/release-announcement",
  "paperclipai/optional/finance/ramp",
  "paperclipai/optional/product/design-critique",
  "paperclipai/optional/research/last30days",
];

const MAX_FRONTMATTER_DESCRIPTION_LENGTH = 300;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKILL_FRONTMATTER_ROOTS = [
  path.join(REPO_ROOT, ".agents"),
  path.join(REPO_ROOT, "skills"),
  path.join(REPO_ROOT, "packages/adapters"),
  path.join(REPO_ROOT, "packages/plugins"),
  path.join(REPO_ROOT, "packages/skills-catalog/catalog"),
  path.join(REPO_ROOT, "packages/teams-catalog/catalog"),
];

function listSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSkillFiles(entryPath);
    if (entry.isFile() && entry.name === "SKILL.md") return [entryPath];
    return [];
  });
}

function readFrontmatterDescription(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1]!.split(/\r?\n/);
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex === -1) return null;

  const inlineValue = lines[descriptionIndex]!.slice("description:".length).trim();
  if (/^[>|][+-]?$/.test(inlineValue)) {
    const descriptionLines: string[] = [];
    for (let index = descriptionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      descriptionLines.push(line.trim());
    }
    return descriptionLines.join(" ").replace(/\s+/g, " ").trim();
  }

  return inlineValue.replace(/^['"]|['"]$/g, "");
}

describe("shipped skills catalog", () => {
  it("ships the summarize-status streaming protocol", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "packages/skills-catalog/catalog/bundled/paperclip-operations/summarize-status/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain("Post the first status update immediately, before doing anything else.");
    expect(skill).toContain('STATUS: considering "Fix login redirect loop"…');
    expect(skill).toContain("STATUS: reading the current slot revision…");
    expect(skill).toContain("<<<SUMMARY-DRAFT>>>");
    expect(skill).toContain("<<<END-SUMMARY-DRAFT>>>");
    expect(skill).toContain("Assistant prose streams token-by-token to the UI; tool-call arguments do not");
    expect(skill).toContain("UI gracefully falls back to its spinner");
    expect(skill).toContain("**Review:**");
    expect(skill).toContain("approve on a skim");
    expect(skill).toContain("**Recent work:**");
    expect(skill).toContain("Not a changelog");
  });

  it("keeps repo and catalog skill descriptions within the prompt budget cap", () => {
    const violations: string[] = [];
    for (const skillFile of SKILL_FRONTMATTER_ROOTS.flatMap(listSkillFiles)) {
      const description = readFrontmatterDescription(readFileSync(skillFile, "utf8"));
      if (!description) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} is missing a frontmatter description`);
      } else if (description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} description is ${description.length} chars`);
      }
    }
    for (const skill of catalogSkills) {
      if (skill.description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${skill.key} generated description is ${skill.description.length} chars`);
      }
    }

    expect(violations).toEqual([]);
  });

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

  it("keeps script-bearing shipped skills explicit so install stays audit-gated", () => {
    // The real install-time security boundary audits materialized bytes and blocks
    // hard-stop findings. Static assets (svg/html templates, e.g. the wireframe skill)
    // carry the "assets" trust level and are installable.
    const scriptBearing = catalogSkills.filter((skill) => skill.trustLevel === "scripts_executables");
    expect(scriptBearing.map((skill) => skill.key)).toEqual([
      "paperclipai/optional/research/last30days",
    ]);
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

  it("keeps the Ramp wrapper fail-closed on mixed-provenance playbooks", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");

    expect(rampSkill).toContain("mixes Official and Community playbooks");
    expect(rampSkill).toContain("do not execute them inside Paperclip unless a Paperclip approval explicitly names the playbook");
    expect(rampSkill).toContain("third-party browser automation, MCP server, CLI, or connector");
  });

  it("keeps the Ramp wrapper clear of remote-fetch execution hard-stop patterns", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");
    const remoteExecPattern = /\b(?:curl|wget)\b[\s\S]{0,160}\|\s*(?:sh|bash)|\b(?:bash|sh)\s+-c\b|\beval\b|\bpython\s+-c\b|\bnode\s+-e\b/i;

    expect(remoteExecPattern.test(rampSkill)).toBe(false);
  });
});
