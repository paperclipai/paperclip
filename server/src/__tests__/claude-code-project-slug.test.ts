import { describe, expect, it } from "vitest";
import { slugifyClaudeCodeProjectCwd } from "../lib/claude-code-project-slug.js";

describe("slugifyClaudeCodeProjectCwd", () => {
  it("matches the observed Claude-Code convention for nested project paths", () => {
    const cwd = "/Users/jane/.paperclip/instances/default/projects/foo/_default";
    expect(slugifyClaudeCodeProjectCwd(cwd)).toBe(
      "-Users-jane--paperclip-instances-default-projects-foo--default",
    );
  });

  it("preserves hyphens already present in identifiers (UUIDs etc.)", () => {
    const cwd = "/Users/me/projects/58cafe4e-122f-4c5a-aba4-5b9b4f31f2bc/workspace";
    expect(slugifyClaudeCodeProjectCwd(cwd)).toBe(
      "-Users-me-projects-58cafe4e-122f-4c5a-aba4-5b9b4f31f2bc-workspace",
    );
  });

  it("returns empty string for empty input", () => {
    expect(slugifyClaudeCodeProjectCwd("")).toBe("");
  });

  it("does not collapse consecutive non-alphanumeric runs", () => {
    expect(slugifyClaudeCodeProjectCwd("/a//b")).toBe("-a--b");
    expect(slugifyClaudeCodeProjectCwd("/a/_b")).toBe("-a--b");
  });

  it("treats unicode and whitespace as non-alphanumeric (replaced with hyphen)", () => {
    expect(slugifyClaudeCodeProjectCwd("/a b/cafe")).toBe("-a-b-cafe");
  });
});
