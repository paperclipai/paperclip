// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { projectMarkdownToText, verifyDocumentAnchorSelector } from "@paperclipai/shared";
import {
  buildAnchorFromContainerSelection,
  getContainerTextOffset,
  rangesForNormalizedSpan,
} from "./document-annotation-selection";

const MARKDOWN = `# Plan

We **should** keep the current markdown stack for the first version.

- Highlight a text segment in a plan document.
- Anchor comments without mutating markdown.

## Acceptance

The annotation feature is ready when the basic flow works.`;

const RENDERED_HTML = `
<div>
  <h1>Plan</h1>
  <p>We should keep the current markdown stack for the first version.</p>
  <ul>
    <li>Highlight a text segment in a plan document.</li>
    <li>Anchor comments without mutating markdown.</li>
  </ul>
  <h2>Acceptance</h2>
  <p>The annotation feature is ready when the basic flow works.</p>
</div>
`;

function makeContainer(): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = RENDERED_HTML;
  document.body.appendChild(div);
  return div.firstElementChild as HTMLElement;
}

function selectText(container: HTMLElement, needle: string): Range {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node = walker.nextNode();
  while (node) {
    const data = (node as Text).data;
    const index = data.indexOf(needle);
    if (index !== -1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      return range;
    }
    node = walker.nextNode();
  }
  throw new Error(`Could not find "${needle}" in container`);
}

describe("buildAnchorFromContainerSelection", () => {
  it("produces a selector that verifies against the same markdown", () => {
    const container = makeContainer();
    const range = selectText(container, "current markdown stack");
    const offset = getContainerTextOffset(container, range);
    expect(offset).not.toBeNull();
    const anchor = buildAnchorFromContainerSelection({
      markdown: MARKDOWN,
      containerOffset: offset!,
    });
    expect(anchor).not.toBeNull();
    const verified = verifyDocumentAnchorSelector({
      markdown: MARKDOWN,
      selector: anchor!.selector,
    });
    expect(verified.ok).toBe(true);
    expect(verified.anchor?.selectedText).toBe("current markdown stack");
  });

  it("returns null for empty selections", () => {
    const container = makeContainer();
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(container, 0);
    const offset = getContainerTextOffset(container, range);
    expect(offset).toBeNull();
  });

  it("returns null when selection is outside container", () => {
    const container = makeContainer();
    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const offset = getContainerTextOffset(container, range);
    expect(offset).toBeNull();
  });

  it("anchors a later duplicate selection to its matching position", () => {
    const markdown = "First repeated text.\n\nSecond repeated text.";
    const container = document.createElement("div");
    container.innerHTML = "<p>First repeated text.</p><p>Second repeated text.</p>";
    document.body.appendChild(container);
    const secondText = container.querySelectorAll("p")[1]!.firstChild as Text;
    const range = document.createRange();
    const start = secondText.data.indexOf("repeated text");
    range.setStart(secondText, start);
    range.setEnd(secondText, start + "repeated text".length);
    const offset = getContainerTextOffset(container, range);
    const anchor = buildAnchorFromContainerSelection({ markdown, containerOffset: offset! });

    const firstOccurrence = markdown.indexOf("repeated text");
    expect(anchor?.selector.position.normalizedStart).toBeGreaterThan(firstOccurrence);
  });
});

describe("rangesForNormalizedSpan", () => {
  it("walks DOM text nodes to find span ranges", () => {
    const container = makeContainer();
    const ranges = rangesForNormalizedSpan({
      container,
      selectedText: "Highlight a text segment",
    });
    expect(ranges.length).toBeGreaterThan(0);
    const merged = ranges.map((range) => range.toString()).join("");
    expect(merged.replace(/\s+/g, " ")).toContain("Highlight a text segment");
  });

  it("returns an empty array if selected text is missing", () => {
    const container = makeContainer();
    const ranges = rangesForNormalizedSpan({
      container,
      selectedText: "this string does not exist in the document",
    });
    expect(ranges).toEqual([]);
  });

  function renderMarkdownContainer(html: string): HTMLDivElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
  }

  function nthOccurrence(text: string, needle: string, ordinal: number): number {
    let index = -1;
    for (let count = 0; count <= ordinal; count += 1) {
      index = text.indexOf(needle, index + 1);
    }
    return index;
  }

  it("uses the supplied normalized position for later duplicate text", () => {
    const markdown = "First repeated text.\n\nSecond repeated text.";
    const container = renderMarkdownContainer("<p>First repeated text.</p><p>Second repeated text.</p>");
    const secondText = container.querySelectorAll("p")[1]!.firstChild as Text;
    const projectionText = projectMarkdownToText(markdown).text;

    const ranges = rangesForNormalizedSpan({
      container,
      selectedText: "repeated text",
      projectionText,
      normalizedStart: nthOccurrence(projectionText, "repeated text", 1),
    });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer).toBe(secondText);
  });

  it("falls back to the first occurrence when no saved position is supplied", () => {
    const container = renderMarkdownContainer("<p>x</p><p>x</p>");
    const firstText = container.querySelectorAll("p")[0]!.firstChild as Text;

    const ranges = rangesForNormalizedSpan({ container, selectedText: "x" });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer).toBe(firstText);
  });

  it.each([0, 1, 2, 3, 4])(
    "resolves occurrence %i of a short quote repeated across paragraphs",
    (ordinal) => {
      const markdown = "x\n\nx\n\nx\n\nx\n\nx";
      const container = renderMarkdownContainer("<p>x</p><p>x</p><p>x</p><p>x</p><p>x</p>");
      const projectionText = projectMarkdownToText(markdown).text;
      const expected = container.querySelectorAll("p")[ordinal]!.firstChild as Text;

      const ranges = rangesForNormalizedSpan({
        container,
        selectedText: "x",
        projectionText,
        normalizedStart: nthOccurrence(projectionText, "x", ordinal),
      });

      expect(ranges).toHaveLength(1);
      expect(ranges[0]?.startContainer).toBe(expected);
    },
  );

  it("is not shifted by image alt text that only exists in the projection", () => {
    const markdown = "x\n\n![long alt](u)\n\nx\n\nx";
    const container = renderMarkdownContainer(
      '<p>x</p><p><img alt="long alt" src="u"></p><p>x</p><p>x</p>',
    );
    const projectionText = projectMarkdownToText(markdown).text;
    const secondX = container.querySelectorAll("p")[2]!.firstChild as Text;

    const ranges = rangesForNormalizedSpan({
      container,
      selectedText: "x",
      projectionText,
      normalizedStart: nthOccurrence(projectionText, "x", 1),
    });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer).toBe(secondX);
  });

  it.each([0, 1, 2, 3, 4])(
    "round-trips selection of occurrence %i into a saved anchor and back to the same node",
    (ordinal) => {
      const markdown = "x\n\nx\n\nx\n\nx\n\nx";
      const container = renderMarkdownContainer("<p>x</p><p>x</p><p>x</p><p>x</p><p>x</p>");
      const target = container.querySelectorAll("p")[ordinal]!.firstChild as Text;
      const range = document.createRange();
      range.setStart(target, 0);
      range.setEnd(target, 1);

      const anchor = buildAnchorFromContainerSelection({
        markdown,
        containerOffset: getContainerTextOffset(container, range)!,
      });
      expect(anchor).not.toBeNull();

      const ranges = rangesForNormalizedSpan({
        container,
        selectedText: anchor!.selector.quote.exact,
        projectionText: anchor!.projection.text,
        normalizedStart: anchor!.selector.position.normalizedStart,
      });

      expect(ranges).toHaveLength(1);
      expect(ranges[0]?.startContainer).toBe(target);
    },
  );
});
