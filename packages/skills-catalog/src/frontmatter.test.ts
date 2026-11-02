import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "./frontmatter.js";

describe("skills catalog frontmatter parsing", () => {
  it("supports YAML block scalars used by SKILL.md descriptions", () => {
    const parsed = parseFrontmatterMarkdown([
      "---",
      "name: Catalog Skill",
      "description: >",
      "  First line",
      "  second line",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(parsed.frontmatter.description).toBe("First line second line\n");
  });

  it("supports block-scalar chomping variants", () => {
    const parsed = parseFrontmatterMarkdown([
      "---",
      "name: Catalog Skill",
      "description: >-",
      "  First line",
      "  second line",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(parsed.frontmatter.description).toBe("First line second line");
  });
});
