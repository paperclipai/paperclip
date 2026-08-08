import { describe, expect, it } from "vitest";
import {
  multilineTextSchema,
  normalizeEscapedLineBreaks,
  normalizeMarkdownBody,
  normalizeMidLineHeadings,
} from "./text.js";

describe("normalizeEscapedLineBreaks", () => {
  it("converts JSON-escaped line breaks to real newlines", () => {
    expect(normalizeEscapedLineBreaks("a\\nb\\r\\nc\\rd")).toBe("a\nb\nc\nd");
  });
});

describe("normalizeMidLineHeadings", () => {
  it("inserts a break before a mid-line ATX heading marker", () => {
    expect(normalizeMidLineHeadings("plan pack)## The goal")).toBe("plan pack)\n\n## The goal");
  });

  it("heals every mid-line heading in a collapsed single-line body", () => {
    const collapsed = "# Plan pack ## The goal, restated ### You picked";
    expect(normalizeMidLineHeadings(collapsed)).toBe(
      "# Plan pack \n\n## The goal, restated \n\n### You picked",
    );
  });

  it("leaves a heading that is already at the start of a line alone", () => {
    const body = "## The goal\n\nYou picked the shared plan pack.";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("leaves a leading heading at the start of the body alone", () => {
    expect(normalizeMidLineHeadings("# Title here")).toBe("# Title here");
  });

  it("does not touch inline `#` tokens like C# and F#", () => {
    const body = "We ship both C# and F# services this quarter.";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("does not touch a `#` glued to a following non-space (hashtags, issue refs)", () => {
    const body = "See #123 and #roadmap for the plan.";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("heals a two-hash marker even when preceded by a word char", () => {
    expect(normalizeMidLineHeadings("restated## The goal")).toBe("restated\n\n## The goal");
  });

  it("ignores runs of 7+ hashes (not a valid heading)", () => {
    const body = "border ####### divider";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("does not rewrite `## ` comments inside fenced code blocks", () => {
    const body = "```yaml\nfoo: bar ## inline comment\n```";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("does not close a long fence with a shorter run", () => {
    const body = "````markdown\n```\ncode ## comment\n````";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("does not close a fence marker that has trailing content", () => {
    const body = "```markdown\n``` still code\ncode ## comment\n```";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });

  it("is a no-op when there is no `#` at all", () => {
    const body = "Just some prose with no markers.";
    expect(normalizeMidLineHeadings(body)).toBe(body);
  });
});

describe("normalizeMarkdownBody / multilineTextSchema", () => {
  it("runs escaped-break normalization before heading healing", () => {
    // Producer sends JSON-escaped newlines plus a mid-line heading.
    expect(normalizeMarkdownBody("Intro.\\n\\n## Section body)## Next")).toBe(
      "Intro.\n\n## Section body)\n\n## Next",
    );
  });

  it("multilineTextSchema leaves unrelated mid-line markers unchanged", () => {
    const parsed = multilineTextSchema.parse("plan pack)## The goal, restated");
    expect(parsed).toBe("plan pack)## The goal, restated");
  });
});
