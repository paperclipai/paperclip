import { describe, expect, it } from "vitest";
import { unescapeBlockquoteMarkers } from "./blockquote-markdown";

describe("unescapeBlockquoteMarkers", () => {
  it("leaves markdown without escaped markers untouched", () => {
    expect(unescapeBlockquoteMarkers("> quoted")).toBe("> quoted");
    expect(unescapeBlockquoteMarkers("plain text")).toBe("plain text");
    expect(unescapeBlockquoteMarkers("")).toBe("");
  });

  it("unescapes a single escaped blockquote line", () => {
    expect(unescapeBlockquoteMarkers("\\> see")).toBe("> see");
  });

  it("unescapes multiple escaped blockquote lines", () => {
    expect(unescapeBlockquoteMarkers("\\> line one\n\\> line two")).toBe("> line one\n> line two");
  });

  it("unescapes escaped blockquotes interleaved with normal text", () => {
    expect(unescapeBlockquoteMarkers("hello\n\n\\> quoted\n\nbye")).toBe("hello\n\n> quoted\n\nbye");
  });

  it("preserves up to 3 spaces of block indent before the marker", () => {
    expect(unescapeBlockquoteMarkers("  \\> indented")).toBe("  > indented");
    expect(unescapeBlockquoteMarkers("   \\> three")).toBe("   > three");
  });

  it("does not touch an escaped marker in an indented code block (4+ spaces)", () => {
    expect(unescapeBlockquoteMarkers("    \\> literal")).toBe("    \\> literal");
    expect(unescapeBlockquoteMarkers("\tcode \\> x")).toBe("\tcode \\> x");
  });

  it("does not touch an escaped marker carrying a blockquote container prefix", () => {
    // A code fence nested inside a blockquote has a `> ` prefix on each line, so
    // its `\>` content must stay escaped.
    expect(unescapeBlockquoteMarkers("> \\> nested")).toBe("> \\> nested");
  });

  it("does not touch an escaped marker inside a list item", () => {
    expect(unescapeBlockquoteMarkers("- \\> item")).toBe("- \\> item");
  });

  it("does not touch escaped markers inside fenced code blocks", () => {
    const input = "```\n\\> not a quote\n```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("```\n\\> not a quote\n```\n> real quote");
  });

  it("does not touch escaped markers inside a list-nested fenced code block", () => {
    const input = "- ```\n  \\> literal\n  ```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("- ```\n  \\> literal\n  ```\n> real quote");
  });

  it("does not close a list-nested fence on a list-marker content line", () => {
    const input = "- ```\n  - ```\n  \\> literal\n  ```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("- ```\n  - ```\n  \\> literal\n  ```\n> real quote");
  });

  it("tracks the continuation indent of an ordered-list fence", () => {
    const input = "10. ```\n    \\> literal\n    ```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("10. ```\n    \\> literal\n    ```\n> real quote");
  });

  it("tracks fenced code blocks through blockquote container prefixes", () => {
    const input = "> ```\n> \\> literal\n> ```\n\\> real quote";
    expect(unescapeBlockquoteMarkers(input)).toBe("> ```\n> \\> literal\n> ```\n> real quote");
  });

  it("handles tilde fences", () => {
    const input = "~~~\n\\> literal\n~~~";
    expect(unescapeBlockquoteMarkers(input)).toBe("~~~\n\\> literal\n~~~");
  });

  it("only rewrites the leading marker, not later text", () => {
    expect(unescapeBlockquoteMarkers("\\> a \\> b")).toBe("> a \\> b");
  });

  it("leaves a mid-line escaped marker alone", () => {
    expect(unescapeBlockquoteMarkers("text \\> not a quote")).toBe("text \\> not a quote");
  });

  it("does not close a fence on a shorter same-char run (nested fence content stays code)", () => {
    // A 3-backtick line inside a 4-backtick fence is code content, not a close,
    // so the escaped marker after it must remain escaped.
    const input = "````\n\\> a\n```\n\\> b\n````\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("````\n\\> a\n```\n\\> b\n````\n> real");
  });

  it("does not treat a fence-like line with trailing content as a closing fence", () => {
    const input = "```\n\\> code\n``` not a close\n\\> still code\n```\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("```\n\\> code\n``` not a close\n\\> still code\n```\n> real");
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const input = "```\n\\> code\n~~~\n\\> still code\n```\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("```\n\\> code\n~~~\n\\> still code\n```\n> real");
  });

  it("closes on a longer run than the opening fence", () => {
    const input = "```\n\\> code\n`````\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("```\n\\> code\n`````\n> real");
  });

  it("treats a backtick fence with a backtick in the info string as non-opening", () => {
    // `` ```` `` with `x` after is not a valid opening fence, so following
    // escaped markers are ordinary paragraph text and get recovered.
    const input = "``` `x`\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("``` `x`\n> real");
  });

  it("keeps an info string on the opening fence and still protects contents", () => {
    const input = "```ts\n\\> code\n```\n\\> real";
    expect(unescapeBlockquoteMarkers(input)).toBe("```ts\n\\> code\n```\n> real");
  });
});
