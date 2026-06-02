import { describe, expect, it } from "vitest";
import { buildInstructionsPrefix, splitInstructionsMarkdown } from "./instructions.js";

describe("splitInstructionsMarkdown", () => {
  it("splits YAML frontmatter from the markdown body", () => {
    const result = splitInstructionsMarkdown(
      [
        "---",
        "name: social_media_specialist",
        "channels:",
        "  - twitter",
        "  - linkedin",
        "---",
        "Write social content.",
        "",
      ].join("\n"),
    );

    expect(result).toEqual({
      frontmatter: {
        name: "social_media_specialist",
        channels: ["twitter", "linkedin"],
      },
      body: "Write social content.\n",
    });
  });
});

describe("buildInstructionsPrefix", () => {
  it("keeps the body text and the file-path note together", () => {
    expect(
      buildInstructionsPrefix("Write social content.", "/tmp/agents/AGENTS.md"),
    ).toBe(
      [
        "Write social content.",
        "The above agent instructions were loaded from /tmp/agents/AGENTS.md. Resolve any relative file references from /tmp/agents/.",
      ].join("\n\n"),
    );
  });
});
