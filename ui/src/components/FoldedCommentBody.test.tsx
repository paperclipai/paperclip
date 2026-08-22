// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FoldedCommentBody,
  LONG_COMMENT_CHARACTER_LIMIT,
} from "./FoldedCommentBody";

describe("FoldedCommentBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderBody(body: string) {
    flushSync(() => {
      root.render(
        <FoldedCommentBody body={body}>
          {(visibleBody) => <div data-testid="visible-body">{visibleBody}</div>}
        </FoldedCommentBody>,
      );
    });
  }

  it("leaves ordinary comments fully rendered without a disclosure control", () => {
    renderBody("A normal project update.");

    expect(container.querySelector('[data-testid="visible-body"]')?.textContent)
      .toBe("A normal project update.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders only the first 20,000 characters until the comment is expanded", () => {
    const body = `${"a".repeat(LONG_COMMENT_CHARACTER_LIMIT)}hidden tail`;
    renderBody(body);

    const visibleBody = container.querySelector('[data-testid="visible-body"]');
    const expand = container.querySelector("button");
    expect(visibleBody?.textContent).toHaveLength(LONG_COMMENT_CHARACTER_LIMIT);
    expect(visibleBody?.textContent).not.toContain("hidden tail");
    expect(expand?.textContent).toContain("Show 11 more characters");
    expect(expand?.getAttribute("aria-expanded")).toBe("false");

    flushSync(() => expand?.click());

    expect(visibleBody?.textContent).toBe(body);
    expect(expand?.textContent).toContain("Show less");
    expect(expand?.getAttribute("aria-expanded")).toBe("true");

    flushSync(() => expand?.click());
    expect(visibleBody?.textContent).toHaveLength(LONG_COMMENT_CHARACTER_LIMIT);
  });

  it("does not split a UTF-16 surrogate pair at the preview boundary", () => {
    const body = `${"a".repeat(LONG_COMMENT_CHARACTER_LIMIT - 1)}😀tail`;
    renderBody(body);

    const visible = container.querySelector('[data-testid="visible-body"]')?.textContent ?? "";
    expect(visible).toBe("a".repeat(LONG_COMMENT_CHARACTER_LIMIT - 1));
    expect(visible).not.toContain("�");
  });

  it("reports when a long body is collapsed so callers can defer structured content", () => {
    const body = `${"a".repeat(LONG_COMMENT_CHARACTER_LIMIT)}hidden tail`;

    flushSync(() => {
      root.render(
        <FoldedCommentBody body={body}>
          {(visibleBody, { isCollapsed, isExpanded }) => (
            <div data-testid="render-state">
              {isCollapsed ? `preview:${visibleBody.length}` : `full:${isExpanded}`}
            </div>
          )}
        </FoldedCommentBody>,
      );
    });

    expect(container.querySelector('[data-testid="render-state"]')?.textContent)
      .toBe(`preview:${LONG_COMMENT_CHARACTER_LIMIT}`);

    flushSync(() => container.querySelector("button")?.click());

    expect(container.querySelector('[data-testid="render-state"]')?.textContent)
      .toBe("full:true");
  });
});
