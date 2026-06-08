import { describe, expect, it } from "vitest";
import { parseCriticMarkup, renderCriticMarkupSuggestion } from "./critic-markup.js";

describe("critic markup helpers", () => {
  it("extracts CriticMarkup-like edits outside code", () => {
    const parsed = parseCriticMarkup("Keep {++new++} {--old--} {~~rough~>polished~~}.");

    expect(parsed.plainMarkdown).toBe("Keep new  polished.");
    expect(parsed.suggestions).toEqual([
      {
        kind: "insertion",
        selectedText: "",
        proposedText: "new",
        markdownStart: 5,
        markdownEnd: 8,
      },
      {
        kind: "deletion",
        selectedText: "old",
        proposedText: null,
        markdownStart: 9,
        markdownEnd: 9,
      },
      {
        kind: "substitution",
        selectedText: "rough",
        proposedText: "polished",
        markdownStart: 10,
        markdownEnd: 18,
      },
    ]);
  });

  it("ignores markers inside inline code and fenced code", () => {
    const parsed = parseCriticMarkup([
      "Visible {--remove--}.",
      "Inline `{++literal++}` stays.",
      "```",
      "{~~old~>new~~}",
      "```",
    ].join("\n"));

    expect(parsed.plainMarkdown).toBe([
      "Visible .",
      "Inline `{++literal++}` stays.",
      "```",
      "{~~old~>new~~}",
      "```",
    ].join("\n"));
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]?.kind).toBe("deletion");
  });

  it("renders optional CriticMarkup export markers", () => {
    expect(renderCriticMarkupSuggestion({
      kind: "substitution",
      selectedText: "old",
      proposedText: "new",
    })).toBe("{~~old~>new~~}");
  });
});
