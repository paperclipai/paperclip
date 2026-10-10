import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeFrontmatterBlock,
  detectFrontmatterRoundTripIssues,
  getSkillFrontmatterUnknownKeys,
  joinFrontmatterBlock,
  parseFrontmatterFields,
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

describe("joinFrontmatterBlock", () => {
  it("is the exact inverse of splitFrontmatterBlock (byte-identity round-trip)", () => {
    const samples = [
      "---\nname: reflection-coach\ndescription: A coach\n---\n# Body\n\nHello\n",
      "---\nname: x\n---\nno trailing newline",
      "---\nname: x\n---\n", // empty body
      "---\ndescription: >\n  folded\n  text\n---\nBody with comment: value\n",
      "# just markdown, no frontmatter\n",
      "---\nunterminated frontmatter\nstill body",
      "---\nmetadata:\n  author: Paperclip\n  # comment stays\n---\nbody\n",
    ];
    for (const raw of samples) {
      expect(joinFrontmatterBlock(splitFrontmatterBlock(raw))).toBe(raw);
    }
  });

  it("returns the body untouched when there is no frontmatter", () => {
    expect(
      joinFrontmatterBlock({ frontmatterText: "", body: "just body", hasFrontmatter: false }),
    ).toBe("just body");
  });
});

describe("parseFrontmatterFields", () => {
  it("parses the raw block text into an object and is lenient on garbage", () => {
    expect(parseFrontmatterFields("name: foo\ndescription: bar")).toEqual({
      name: "foo",
      description: "bar",
    });
    expect(parseFrontmatterFields("")).toEqual({});
    expect(parseFrontmatterFields("# only a comment")).toEqual({});
  });
});

describe("analyzeFrontmatterBlock", () => {
  it("marks a simple inline block as round-trippable", () => {
    const result = analyzeFrontmatterBlock("name: reflection-coach\ndescription: A coach");
    expect(result.canRoundTrip).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parsed).toEqual({ name: "reflection-coach", description: "A coach" });
  });

  it("marks a block with allowed-tools and metadata as round-trippable", () => {
    const raw = [
      "name: coach",
      "description: A coach",
      "allowed-tools:",
      "  - Read",
      "  - Grep",
      "metadata:",
      "  author: Paperclip",
      "  version: 2",
    ].join("\n");
    const result = analyzeFrontmatterBlock(raw);
    expect(result.canRoundTrip).toBe(true);
    expect(result.parsed["allowed-tools"]).toEqual(["Read", "Grep"]);
  });

  it("refuses fields mode when comments are present (would be dropped)", () => {
    const result = analyzeFrontmatterBlock("name: coach # inline note\ndescription: x");
    expect(result.canRoundTrip).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "comment")).toBe(true);
  });

  it("refuses fields mode for folded scalars the serializer cannot reproduce", () => {
    const raw = ["description: >", "  first line", "  second line"].join("\n");
    const result = analyzeFrontmatterBlock(raw);
    // No detector "issue", but re-serialization is not byte-identical, so it is
    // still not round-trippable — the strict serialize-back gate catches it.
    expect(result.canRoundTrip).toBe(false);
  });

  it("treats an empty block as round-trippable", () => {
    const result = analyzeFrontmatterBlock("");
    expect(result.canRoundTrip).toBe(true);
    expect(result.parsed).toEqual({});
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
