import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "./frontmatter.js";

describe("parseFrontmatterMarkdown", () => {
  it("parses folded and literal YAML block scalars", () => {
    const folded = parseFrontmatterMarkdown([
      "---",
      "name: Folded",
      "description: >",
      "  First line",
      "  second line",
      "",
      "  Third paragraph",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(folded.frontmatter.description).toBe("First line second line\n\nThird paragraph\n");

    const literal = parseFrontmatterMarkdown([
      "---",
      "name: Literal",
      "description: |",
      "  First line",
      "  second line",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(literal.frontmatter.description).toBe("First line\nsecond line\n");
  });

  it("respects block-scalar chomping indicators", () => {
    const foldedStrip = parseFrontmatterMarkdown([
      "---",
      "description: >-",
      "  First line",
      "  second line",
      "",
      "  Third paragraph",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(foldedStrip.frontmatter.description).toBe("First line second line\n\nThird paragraph");

    const literalKeep = parseFrontmatterMarkdown([
      "---",
      "description: |+",
      "  First line",
      "  second line",
      "",
      "",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(literalKeep.frontmatter.description).toBe("First line\nsecond line\n\n");
  });

  it("parses inline object array items nested under frontmatter keys", () => {
    const parsed = parseFrontmatterMarkdown([
      "---",
      "metadata:",
      "  sources:",
      "    - kind: github-dir",
      "      repo: paperclipai/paperclip",
      "      path: skills/paperclip",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(parsed.frontmatter).toMatchObject({
      metadata: {
        sources: [
          {
            kind: "github-dir",
            repo: "paperclipai/paperclip",
            path: "skills/paperclip",
          },
        ],
      },
    });
  });
});
