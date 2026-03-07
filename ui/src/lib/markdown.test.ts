import { describe, expect, it } from "vitest";
import { normalizeMarkdownArtifacts } from "./markdown";

describe("normalizeMarkdownArtifacts", () => {
  it("normalizes escaped unordered list markers and space entities", () => {
    const input = "Here is a list:\n\n\\* foo&#x20;\n\\- bar&#x20;";
    const output = normalizeMarkdownArtifacts(input);
    expect(output).toBe("Here is a list:\n\n* foo \n- bar ");
  });

  it("does not rewrite escaped markers inside fenced code blocks", () => {
    const input = "```md\n\\* keep literal&#x20;\n\\- keep literal&#x20;\n```";
    expect(normalizeMarkdownArtifacts(input)).toBe(input);
  });

  it("keeps escaped non-list syntax intact", () => {
    const input = "\\*not-a-list";
    expect(normalizeMarkdownArtifacts(input)).toBe(input);
  });
});
