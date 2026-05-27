// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { verifyDocumentAnchorSelector } from "@paperclipai/shared";
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
});
