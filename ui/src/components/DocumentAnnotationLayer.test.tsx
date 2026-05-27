// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentAnnotationLayer } from "./DocumentAnnotationLayer";

const mockRangesForNormalizedSpan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/document-annotation-selection", () => ({
  buildAnchorFromContainerSelection: vi.fn(),
  getContainerTextOffset: vi.fn(),
  rangesForNormalizedSpan: mockRangesForNormalizedSpan,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeRange(rects: DOMRect[], commonAncestorContainer: Node = document.createTextNode("")): Range {
  return {
    commonAncestorContainer,
    getClientRects: () => rects,
  } as unknown as Range;
}

describe("DocumentAnnotationLayer", () => {
  let container: HTMLDivElement;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockRangesForNormalizedSpan.mockReturnValue([makeRange([makeRect(8, 12, 80, 18)])]);
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(makeRect(0, 0, 400, 300));
  });

  afterEach(async () => {
    if (root) {
      await act(() => root?.unmount());
      root = null;
    }
    rectSpy.mockRestore();
    container.remove();
    vi.clearAllMocks();
  });

  it("uses solid yellow backgrounds for annotation highlights in light and dark themes", async () => {
    const body = document.createElement("div");
    body.textContent = "Annotated body text.";
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Annotated body text."
          threads={[
            { id: "active", selectedText: "Annotated", status: "open", anchorState: "active" },
            { id: "focused", selectedText: "body", status: "open", anchorState: "active" },
            { id: "stale", selectedText: "text", status: "open", anchorState: "stale" },
            { id: "resolved", selectedText: "body text", status: "resolved", anchorState: "active" },
          ]}
          focusedThreadId="focused"
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={vi.fn()}
          onRequestComment={vi.fn()}
          hideResolved={false}
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    const highlights = Array.from(container.querySelectorAll(".paperclip-doc-annotation-highlight"));
    expect(highlights).toHaveLength(4);

    for (const highlight of highlights) {
      const backgroundClasses = Array.from(highlight.classList).filter((className) =>
        /^(dark:|hover:|dark:hover:)?bg-yellow-\d+$/.test(className)
        || /^(dark:|hover:|dark:hover:)?bg-yellow-\d+\//.test(className),
      );
      expect(backgroundClasses.some((className) => className.includes("/"))).toBe(false);
      expect(backgroundClasses.some((className) => className.startsWith("bg-yellow-"))).toBe(true);
      expect(backgroundClasses.some((className) => className.startsWith("dark:bg-yellow-"))).toBe(true);
    }
  });

  it("does not render highlights for text clipped by folded document content", async () => {
    const body = document.createElement("div");
    const clippedContent = document.createElement("div");
    clippedContent.className = "fold-curtain__content";
    const hiddenText = document.createTextNode("Hidden folded text");
    clippedContent.appendChild(hiddenText);
    body.appendChild(clippedContent);
    mockRangesForNormalizedSpan.mockReturnValue([makeRange([makeRect(8, 60, 80, 18)], hiddenText)]);
    rectSpy.mockImplementation(function (this: HTMLElement) {
      if (this === clippedContent) return makeRect(0, 0, 400, 40);
      return makeRect(0, 0, 400, 120);
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Hidden folded text"
          threads={[
            { id: "hidden", selectedText: "Hidden folded text", status: "open", anchorState: "active" },
          ]}
          focusedThreadId={null}
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={vi.fn()}
          onRequestComment={vi.fn()}
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(container.querySelector(".paperclip-doc-annotation-highlight")).toBeNull();
    expect(container.querySelector(".paperclip-doc-annotation-hit-target")).toBeNull();
  });

  it("uses native CSS highlights for visual paint when the browser supports them", async () => {
    const originalCss = globalThis.CSS;
    const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight;
    const setHighlight = vi.fn();
    const deleteHighlight = vi.fn();
    class MockHighlight {
      ranges: Range[];

      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    (globalThis as { CSS?: unknown }).CSS = {
      ...(originalCss ?? {}),
      highlights: {
        set: setHighlight,
        delete: deleteHighlight,
      },
    };
    (globalThis as { Highlight?: unknown }).Highlight = MockHighlight;

    const body = document.createElement("div");
    body.textContent = "Annotated body text.";
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Annotated body text."
          threads={[
            { id: "active", selectedText: "Annotated", status: "open", anchorState: "active" },
          ]}
          focusedThreadId={null}
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={vi.fn()}
          onRequestComment={vi.fn()}
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(container.querySelector(".paperclip-doc-annotation-highlight")).toBeNull();
    expect(container.querySelector(".paperclip-doc-annotation-hit-target")).not.toBeNull();
    const openHighlightCall = setHighlight.mock.calls.find(([name]) => name === "paperclip-doc-annotation-open");
    expect(openHighlightCall).toBeTruthy();
    expect((openHighlightCall?.[1] as MockHighlight).ranges).toHaveLength(1);

    await act(async () => root?.unmount());
    root = null;
    expect(deleteHighlight).toHaveBeenCalledWith("paperclip-doc-annotation-open");

    (globalThis as { CSS?: unknown }).CSS = originalCss;
    (globalThis as { Highlight?: unknown }).Highlight = originalHighlight;
  });
});
