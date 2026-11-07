import { describe, expect, it } from "vitest";
import { restoreTrailingMarkdownSpaces } from "./trailing-markdown-spaces";

describe("restoreTrailingMarkdownSpaces", () => {
  it.each([
    ["Send this&#x20;", "Send this "],
    ["Send this &#x20;\n", "Send this  \n"],
    ["Send this&#x20;&#x20;\n\n", "Send this  \n\n"],
    ["> - Send this&#x20;", "> - Send this "],
    ["Keep&#x20;this&#x20;", "Keep&#x20;this "],
    ["First line&#x20;\nsecond&#x20;\n", "First line&#x20;\nsecond \n"],
    ["**bold&#x20;**&#x20;\n", "**bold&#x20;** \n"],
    ["Use `&#x20;`&#x20;", "Use `&#x20;` "],
    [String.raw`Use \\&#x20;`, String.raw`Use \\` + " "],
  ])("restores trailing prose spaces: %s", (input, expected) => {
    expect(restoreTrailingMarkdownSpaces(input)).toBe(expected);
  });

  it.each([
    "",
    "Keep two spaces  \nfor a hard break",
    "Keep&#x20;this",
    "First line&#x20;\nsecond",
    "First line&#x20;&#x20;\nsecond",
    "**bold&#x20;**\n",
    "*italic&#x20;*\n",
    String.raw`Keep \&#x20;`,
    String.raw`Keep \\\&#x20;`,
    "Use `&#x20;`",
    "```text\n&#x20;",
    "> ```text\n> &#x20;",
    "    &#x20;",
    "<div>\n&#x20;",
    "[link](https://example.com/&#x20;)",
  ])("preserves literal entities and other Markdown: %s", (input) => {
    expect(restoreTrailingMarkdownSpaces(input)).toBe(input);
  });
});
