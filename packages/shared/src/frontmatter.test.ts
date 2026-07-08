import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectFrontmatterRoundTripIssues,
  getSkillFrontmatterUnknownKeys,
  parseFrontmatterMarkdown,
  skillFrontmatterSchema,
  splitFrontmatterBlock,
  stringifyFrontmatter,
} from "./frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skillMarkdownSearchRoots = [
  "packages/skills-catalog/catalog",
  "packages/teams-catalog/catalog",
  "packages/adapters/hermes/skills",
  "packages/plugins/plugin-llm-wiki/skills",
  "skills",
];

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

  it("does not treat trailing-dot decimals as numbers", () => {
    const parsed = parseFrontmatterMarkdown([
      "---",
      "version: 1.",
      "---",
      "",
    ].join("\n"));

    expect(parsed.frontmatter.version).toBe("1.");
  });
});

describe("splitFrontmatterBlock", () => {
  it("splits every bundled skill markdown file without losing bytes", () => {
    const skillMarkdownFiles = collectSkillMarkdownFiles();

    expect(skillMarkdownFiles.length).toBeGreaterThan(0);
    for (const filePath of skillMarkdownFiles) {
      const raw = fs.readFileSync(filePath, "utf8");
      const split = splitFrontmatterBlock(raw);
      const joined = split.hasFrontmatter
        ? `---\n${split.frontmatterText}\n---\n${split.body}`
        : split.body;

      expect(joined, path.relative(repoRoot, filePath)).toBe(raw);
    }
  });

  it("leaves files without frontmatter untouched", () => {
    const raw = "Body starts immediately.\n\n---\nThis is not frontmatter.\n";
    const split = splitFrontmatterBlock(raw);

    expect(split).toEqual({
      frontmatterText: "",
      body: raw,
      hasFrontmatter: false,
    });
  });

  it("treats an empty opening block as frontmatter", () => {
    const raw = "---\n---\nBody\n";

    expect(splitFrontmatterBlock(raw)).toEqual({
      frontmatterText: "",
      body: "Body\n",
      hasFrontmatter: true,
    });
  });
});

describe("stringifyFrontmatter", () => {
  it.each([
    {
      label: "nested metadata",
      value: {
        name: "demo-skill",
        description: "Demo skill",
        metadata: {
          source: {
            kind: "github-dir",
            repo: "paperclipai/paperclip",
            path: "skills/paperclip",
          },
        },
      },
    },
    {
      label: "arrays",
      value: {
        name: "tool-skill",
        description: "Tool skill",
        "allowed-tools": ["Read", "Write", "Bash"],
        tags: ["skills", "frontmatter"],
      },
    },
    {
      label: "block scalars",
      value: {
        name: "block-skill",
        description: "First line\nsecond line\n\nThird paragraph\n",
        metadata: {
          notes: "Keep\nall\nline breaks",
        },
      },
    },
  ])("serializes parser-compatible YAML for $label", ({ value }) => {
    const first = parseFrontmatterMarkdown(`---\n${stringifyFrontmatter(value)}\n---\n`).frontmatter;
    const second = parseFrontmatterMarkdown(`---\n${stringifyFrontmatter(first)}\n---\n`).frontmatter;

    expect(second).toEqual(first);
  });
});

describe("skillFrontmatterSchema", () => {
  it("validates core skill frontmatter fields while allowing unknown keys", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "demo-skill",
      description: "A demo skill.",
      "allowed-tools": ["Read", "Write"],
      metadata: { nested: { enabled: true } },
      tags: ["demo"],
    });

    expect(parsed.tags).toEqual(["demo"]);
    expect(getSkillFrontmatterUnknownKeys(parsed)).toEqual(["tags"]);
  });

  it("rejects non-slug skill names", () => {
    expect(() => skillFrontmatterSchema.parse({
      name: "Demo Skill",
      description: "A demo skill.",
    })).toThrow();
  });
});

describe("detectFrontmatterRoundTripIssues", () => {
  it("reports YAML constructs that fields mode cannot preserve", () => {
    const issues = detectFrontmatterRoundTripIssues([
      "# leading comment",
      "\"quoted-key\": value",
      "base: &base",
      "copy: *base",
    ].join("\n"));

    expect(issues.map((issue) => issue.kind)).toEqual([
      "comment",
      "quoted_key",
      "anchor",
      "alias",
    ]);
  });
});

function collectSkillMarkdownFiles() {
  return skillMarkdownSearchRoots.flatMap((relativeRoot) => {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    return fs.existsSync(absoluteRoot) ? collectSkillMarkdownFilesUnder(absoluteRoot) : [];
  }).sort();
}

function collectSkillMarkdownFilesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSkillMarkdownFilesUnder(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(absolutePath);
    }
  }
  return files;
}
