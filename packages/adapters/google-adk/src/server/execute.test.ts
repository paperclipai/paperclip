import { describe, expect, it } from "vitest";
import { buildInstructionsPrefix, splitInstructionsMarkdown } from "./instructions.js";

describe("splitInstructionsMarkdown", () => {
  it("splits YAML frontmatter from the markdown body", () => {
    const result = splitInstructionsMarkdown(
      [
        "---",
        "name: example_agent",
        "capabilities:",
        "  - research",
        "  - planning",
        "---",
        "Follow the instructions.",
        "",
      ].join("\n"),
    );

    expect(result).toEqual({
      frontmatter: {
        name: "example_agent",
        capabilities: ["research", "planning"],
      },
      body: "Follow the instructions.\n",
    });
  });

  it("passes through markdown without frontmatter", () => {
    expect(splitInstructionsMarkdown("Follow the instructions.\n")).toEqual({
      frontmatter: {},
      body: "Follow the instructions.\n",
    });
  });

  it("handles an empty frontmatter block", () => {
    expect(
      splitInstructionsMarkdown(
        [
          "---",
          "---",
          "Follow the instructions.",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      frontmatter: {},
      body: "Follow the instructions.\n",
    });
  });
});

describe("buildInstructionsPrefix", () => {
  it("keeps the body text and the file-path note together", () => {
    expect(
      buildInstructionsPrefix("Follow the instructions.", "/tmp/agents/AGENTS.md"),
    ).toBe(
      [
        "Follow the instructions.",
        "The above agent instructions were loaded from /tmp/agents/AGENTS.md. Resolve any relative file references from /tmp/agents/.",
      ].join("\n\n"),
    );
  });

  it("returns an empty string when there is no body", () => {
    expect(buildInstructionsPrefix("", "/tmp/agents/AGENTS.md")).toBe("");
  });
});
