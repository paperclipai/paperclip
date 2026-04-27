import { describe, expect, it } from "vitest";
import { stripMarkdownCodeSegments } from "../services/issues.ts";

describe("stripMarkdownCodeSegments", () => {
  it("returns the empty string unchanged", () => {
    expect(stripMarkdownCodeSegments("")).toBe("");
  });

  it("leaves plain prose alone", () => {
    const body = "hey @cto please review";
    expect(stripMarkdownCodeSegments(body)).toBe(body);
  });

  it("blanks out a single inline code span", () => {
    const body = "docs: `@cto` is the slug form";
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).not.toContain("@cto");
    expect(stripped).not.toContain("`");
    expect(stripped.length).toBe(body.length);
    expect(stripped.startsWith("docs: ")).toBe(true);
    expect(stripped.endsWith(" is the slug form")).toBe(true);
  });

  it("blanks out multiple inline spans on the same line", () => {
    const body = "use `@cto`/`@ceo` to tag";
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).not.toContain("@cto");
    expect(stripped).not.toContain("@ceo");
    expect(stripped).not.toContain("`");
    expect(stripped).toContain("/");
    expect(stripped).toContain("to tag");
    expect(stripped.length).toBe(body.length);
  });

  it("strips fenced code blocks across multiple lines", () => {
    const body = [
      "intro",
      "```md",
      "Ping @cto",
      "```",
      "outro",
    ].join("\n");
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).not.toContain("@cto");
    expect(stripped.startsWith("intro\n")).toBe(true);
    expect(stripped.endsWith("\noutro")).toBe(true);
  });

  it("preserves text between code segments", () => {
    const body = "alpha `@cto` beta @ceo gamma `@senior-engineer` delta";
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).toContain("beta @ceo gamma");
    expect(stripped).not.toContain("@cto");
    expect(stripped).not.toContain("@senior-engineer");
  });

  it("preserves newline characters inside fenced blocks", () => {
    const body = "a\n```\n@cto\n```\nb";
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).not.toContain("@cto");
    expect(stripped).not.toContain("`");
    expect(stripped.length).toBe(body.length);
    // Newlines preserved so line-based tooling still aligns.
    expect((stripped.match(/\n/g) ?? []).length).toBe(4);
    expect(stripped.startsWith("a\n")).toBe(true);
    expect(stripped.endsWith("\nb")).toBe(true);
  });

  it("does not collapse a triple fence into three single spans", () => {
    // If inline-span logic were run first it would match the triple fence as
    // three adjacent single-tick empty spans and leave the @cto inside exposed.
    const body = "```\n@cto inside fence\n```";
    const stripped = stripMarkdownCodeSegments(body);
    expect(stripped).not.toContain("@cto");
  });
});
