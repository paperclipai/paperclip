import { describe, expect, it } from "vitest";
import {
  createDocumentAnchorSelector,
  projectMarkdownToText,
  remapDocumentAnchor,
  resolveProjectionRange,
  verifyDocumentAnchorSelector,
} from "./document-anchors.js";

function selectorFor(markdown: string, quote: string) {
  const projection = projectMarkdownToText(markdown);
  const start = projection.text.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const range = resolveProjectionRange(projection, start, start + quote.length);
  expect(range).not.toBeNull();
  return createDocumentAnchorSelector(projection, range!);
}

describe("document text projection", () => {
  it("projects markdown into normalized rendered text with source ranges", () => {
    const markdown = [
      "# Heading",
      "",
      "- Ship **bold** [link text](https://example.com) and `code span`.",
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | Beta |",
    ].join("\n");

    const projection = projectMarkdownToText(markdown);

    expect(projection.text).toContain("Heading");
    expect(projection.text).toContain("Ship bold link text and code span.");
    expect(projection.text).toContain("Name Value");
    expect(projection.text).toContain("Alpha Beta");
    expect(projection.text).not.toContain("https://example.com");
    expect(projection.positions).toHaveLength(projection.text.length);

    const linkStart = projection.text.indexOf("link text");
    const range = resolveProjectionRange(projection, linkStart, linkStart + "link text".length);
    expect(range?.markdownStart).toBe(markdown.indexOf("link text"));
    expect(range?.markdownEnd).toBe(markdown.indexOf("link text") + "link text".length);
  });

  it("normalizes whitespace while retaining markdown offsets", () => {
    const markdown = "First   line\n\nSecond\t\tline";
    const projection = projectMarkdownToText(markdown);

    expect(projection.text).toBe("First line Second line");
    const range = resolveProjectionRange(projection, projection.text.indexOf("Second"), projection.text.length);
    expect(range?.markdownStart).toBe(markdown.indexOf("Second"));
    expect(range?.markdownEnd).toBe(markdown.length);
  });

  it("preserves non-link punctuation", () => {
    const markdown = "Keep (parenthetical) [plain brackets] visible.";
    const projection = projectMarkdownToText(markdown);

    expect(projection.text).toBe("Keep (parenthetical) [plain brackets] visible.");
  });
});

describe("document anchor verification and remapping", () => {
  it("verifies a selector against its base revision", () => {
    const markdown = "Intro text with **selected text** inside.";
    const selector = selectorFor(markdown, "selected text");

    const result = verifyDocumentAnchorSelector({ markdown, selector });

    expect(result.ok).toBe(true);
    expect(result.anchor?.selectedText).toBe("selected text");
    expect(result.anchor?.markdownStart).toBe(markdown.indexOf("selected text"));
  });

  it("remaps exact anchors after surrounding text moves", () => {
    const selector = selectorFor("Alpha paragraph.\n\nTarget sentence here.\n\nOmega paragraph.", "Target sentence here.");
    const previousAnchor = {
      selectedText: selector.quote.exact,
      prefixText: selector.quote.prefix,
      suffixText: selector.quote.suffix,
      normalizedStart: selector.position.normalizedStart,
      normalizedEnd: selector.position.normalizedEnd,
      markdownStart: selector.position.markdownStart,
      markdownEnd: selector.position.markdownEnd,
    };

    const result = remapDocumentAnchor({
      previousAnchor,
      nextMarkdown: "Omega paragraph.\n\nAlpha paragraph.\n\nTarget sentence here.",
    });

    expect(result.anchorState).toBe("active");
    expect(result.confidence).toBe("exact");
    expect(result.anchor?.selectedText).toBe("Target sentence here.");
  });

  it("uses context and proximity to disambiguate duplicate quotes", () => {
    const selector = selectorFor("One apple near the start.\n\nTwo apple near the end.", "apple");
    const previousAnchor = {
      selectedText: selector.quote.exact,
      prefixText: selector.quote.prefix,
      suffixText: selector.quote.suffix,
      normalizedStart: selector.position.normalizedStart,
      normalizedEnd: selector.position.normalizedEnd,
      markdownStart: selector.position.markdownStart,
      markdownEnd: selector.position.markdownEnd,
    };

    const result = remapDocumentAnchor({
      previousAnchor,
      nextMarkdown: "Zero apple elsewhere.\n\nOne apple near the start.\n\nTwo apple near the end.",
    });

    expect(result.anchorState).toBe("active");
    expect(result.confidence).toBe("duplicate");
    expect(result.anchor?.prefixText).toContain("One");
  });

  it("marks duplicate anchors ambiguous when context cannot distinguish them", () => {
    const selector = selectorFor("apple apple", "apple");
    const previousAnchor = {
      selectedText: selector.quote.exact,
      prefixText: "",
      suffixText: "",
      normalizedStart: selector.position.normalizedStart,
      normalizedEnd: selector.position.normalizedEnd,
      markdownStart: selector.position.markdownStart,
      markdownEnd: selector.position.markdownEnd,
    };

    const result = remapDocumentAnchor({ previousAnchor, nextMarkdown: "apple apple" });

    expect(result.anchorState).toBe("stale");
    expect(result.confidence).toBe("ambiguous");
  });

  it("keeps edited anchors as stale fuzzy matches", () => {
    const selector = selectorFor("We rely on an important launch assumption for scope.", "important launch assumption");
    const previousAnchor = {
      selectedText: selector.quote.exact,
      prefixText: selector.quote.prefix,
      suffixText: selector.quote.suffix,
      normalizedStart: selector.position.normalizedStart,
      normalizedEnd: selector.position.normalizedEnd,
      markdownStart: selector.position.markdownStart,
      markdownEnd: selector.position.markdownEnd,
    };

    const result = remapDocumentAnchor({
      previousAnchor,
      nextMarkdown: "We rely on an important product launch assumption for scope.",
    });

    expect(result.anchorState).toBe("stale");
    expect(result.confidence).toBe("fuzzy");
    expect(result.anchor?.selectedText).toBe("important product launch assumption");
  });

  it("marks deleted anchors orphaned and allows future remapping from the latest known anchor", () => {
    const selector = selectorFor("Keep this reviewed phrase in mind.", "reviewed phrase");
    const previousAnchor = {
      selectedText: selector.quote.exact,
      prefixText: selector.quote.prefix,
      suffixText: selector.quote.suffix,
      normalizedStart: selector.position.normalizedStart,
      normalizedEnd: selector.position.normalizedEnd,
      markdownStart: selector.position.markdownStart,
      markdownEnd: selector.position.markdownEnd,
    };

    const missing = remapDocumentAnchor({ previousAnchor, nextMarkdown: "The target disappeared." });
    const recovered = remapDocumentAnchor({
      previousAnchor,
      nextMarkdown: "The target came back: reviewed phrase.",
    });

    expect(missing.anchorState).toBe("orphaned");
    expect(missing.confidence).toBe("missing");
    expect(missing.anchor).toBeNull();
    expect(recovered.anchorState).toBe("active");
    expect(recovered.anchor?.selectedText).toBe("reviewed phrase");
  });
});
