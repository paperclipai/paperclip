/**
 * @file paperclip-create-plugin-skill.test.ts
 * @description Integrity and regression tests for the 'paperclip-create-plugin' agent skill.
 * 
 * These tests ensure that the skill documentation and its associated reference files
 * are present, correctly formatted, and properly linked. This is critical for 
 * maintaining high-quality guidance for AI agents implementing plugins.
 * 
 * The suite verifies:
 * - Presence and basic frontmatter of SKILL.md
 * - Existence of all required reference documentation (SDK, Manifest, API, etc.)
 * - Validity of links within the skill documentation to these references.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("paperclip-create-plugin skill", () => {
  // Path relative to the workspace root
  const rootDir = path.resolve(__dirname, "../../../");
  const skillDir = path.join(rootDir, "skills/paperclip-create-plugin");
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const referencesDir = path.join(skillDir, "references");

  it("should have a SKILL.md file", () => {
    expect(fs.existsSync(skillMdPath)).toBe(true);
  });

  it("should have valid frontmatter in SKILL.md", () => {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    expect(content).toMatch(/^---/);
    expect(content).toContain("name: paperclip-create-plugin");
    expect(content).toContain("description:");
    expect(content).toMatch(/---\n/);
  });

  it("should have a references directory", () => {
    expect(fs.existsSync(referencesDir)).toBe(true);
    expect(fs.statSync(referencesDir).isDirectory()).toBe(true);
  });

  const expectedReferences = [
    "PLUGIN_SPEC.md",
    "PLUGIN_AUTHORING_GUIDE.md",
    "scaffold-tool.md",
    "sdk.md",
    "api-types.md",
    "manifest-types.md",
    "constants.md",
    "ui-sdk.md"
  ];

  expectedReferences.forEach(ref => {
    it(`should have reference file: ${ref}`, () => {
      const refPath = path.join(referencesDir, ref);
      expect(fs.existsSync(refPath)).toBe(true);
    });
  });

  it("should have all references linked in SKILL.md", () => {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    expectedReferences.forEach(ref => {
      // Check for markdown links like [text](references/file.md) or just the path
      const linkPattern = new RegExp(`references/${ref.replace(".", "\\.")}`);
      expect(content).toMatch(linkPattern);
    });
  });
});
