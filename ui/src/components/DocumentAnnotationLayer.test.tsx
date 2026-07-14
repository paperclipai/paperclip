// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentAnnotationLayer } from "./DocumentAnnotationLayer";

const mockBuildAnchorFromContainerSelection = vi.hoisted(() => vi.fn());
const mockGetContainerTextOffset = vi.hoisted(() => vi.fn());
const mockRangesForNormalizedSpan = vi.hoisted(() => vi.fn());
const mockIsCoarsePointerDevice = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/lib/document-annotation-selection", () => ({
  buildAnchorFromContainerSelection: mockBuildAnchorFromContainerSelection,
  getContainerTextOffset: mockGetContainerTextOffset,
  isCoarsePointerDevice: mockIsCoarsePointerDevice,
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
    mockIsCoarsePointerDevice.mockReturnValue(false);
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

  it("does not capture annotation comments from editable selections", async () => {
    const body = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const text = document.createTextNode("Editing routine instructions");
    editable.appendChild(text);
    body.appendChild(editable);

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Editing".length);
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    const onPendingAnchorChange = vi.fn();
    root = createRoot(container);

    try {
      await act(async () => {
        root?.render(
          <DocumentAnnotationLayer
            containerRef={{ current: body }}
            markdown="Editing routine instructions"
            threads={[]}
            focusedThreadId={null}
            onThreadFocus={vi.fn()}
            pendingAnchor={null}
            onPendingAnchorChange={onPendingAnchorChange}
            onRequestComment={vi.fn()}
          />,
        );
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });

      expect(mockGetContainerTextOffset).not.toHaveBeenCalled();
      expect(mockBuildAnchorFromContainerSelection).not.toHaveBeenCalled();
      expect(onPendingAnchorChange).toHaveBeenCalledWith(null);
      expect(container.querySelector('[data-testid="document-annotation-selection-toolbar"]')).toBeNull();
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it("does not capture annotation comments from bare contenteditable selections", async () => {
    const body = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const text = document.createTextNode("Editing routine instructions");
    editable.appendChild(text);
    body.appendChild(editable);

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Editing".length);
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    const onPendingAnchorChange = vi.fn();
    root = createRoot(container);

    try {
      await act(async () => {
        root?.render(
          <DocumentAnnotationLayer
            containerRef={{ current: body }}
            markdown="Editing routine instructions"
            threads={[]}
            focusedThreadId={null}
            onThreadFocus={vi.fn()}
            pendingAnchor={null}
            onPendingAnchorChange={onPendingAnchorChange}
            onRequestComment={vi.fn()}
          />,
        );
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });

      expect(mockGetContainerTextOffset).not.toHaveBeenCalled();
      expect(mockBuildAnchorFromContainerSelection).not.toHaveBeenCalled();
      expect(onPendingAnchorChange).toHaveBeenCalledWith(null);
      expect(container.querySelector('[data-testid="document-annotation-selection-toolbar"]')).toBeNull();
    } finally {
      getSelectionSpy.mockRestore();
    }
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

  it("makes run-sized annotation hit targets selection-transparent on coarse pointers", async () => {
    mockIsCoarsePointerDevice.mockReturnValue(true);
    const body = document.createElement("div");
    body.textContent = "Annotated body text.";
    const onThreadFocus = vi.fn();
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Annotated body text."
          threads={[
            { id: "thread-1", selectedText: "Annotated", status: "open", anchorState: "active" },
          ]}
          focusedThreadId={null}
          onThreadFocus={onThreadFocus}
          pendingAnchor={null}
          onPendingAnchorChange={vi.fn()}
          onRequestComment={vi.fn()}
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    const hitTarget = container.querySelector<HTMLButtonElement>(".paperclip-doc-annotation-hit-target");
    expect(hitTarget?.className).toContain("pointer-events-none");

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    expect(hitTarget?.dispatchEvent(mouseDown)).toBe(true);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(onThreadFocus).not.toHaveBeenCalled();

    const tailFocus = container.querySelector<HTMLButtonElement>('[data-testid="document-annotation-focus-tail"]');
    expect(tailFocus?.className).toContain("pointer-events-auto");
    tailFocus?.click();
    expect(onThreadFocus).toHaveBeenCalledWith("thread-1");
  });

  it("skips native highlight registry rewrites during an active selection gesture", async () => {
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
    const containerRef = { current: body };
    const textNode = document.createTextNode("Annotated body text.");
    body.appendChild(textNode);
    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, 0);
    selectionRange.setEnd(textNode, "Annotated".length);
    selectionRange.getBoundingClientRect = () => makeRect(12, 24, 64, 18);
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => selectionRange,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 9,
      containerText: "Annotated body text.",
      selectedText: "Annotated",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Annotated", prefix: "", suffix: " body" },
        position: { normalizedStart: 0, normalizedEnd: 9, markdownStart: 0, markdownEnd: 9 },
      },
    });
    root = createRoot(container);
    const onThreadFocus = vi.fn();
    const onPendingAnchorChange = vi.fn();
    const onRequestComment = vi.fn();

    try {
      const renderLayer = (focusedThreadId: string | null) => (
        <DocumentAnnotationLayer
          containerRef={containerRef}
          markdown="Annotated body text."
          threads={[
            { id: "thread-1", selectedText: "Annotated", status: "open", anchorState: "active" },
          ]}
          focusedThreadId={focusedThreadId}
          onThreadFocus={onThreadFocus}
          pendingAnchor={null}
          onPendingAnchorChange={onPendingAnchorChange}
          onRequestComment={onRequestComment}
        />
      );

      await act(async () => {
        root?.render(renderLayer(null));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
      setHighlight.mockClear();
      deleteHighlight.mockClear();

      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
        root?.render(renderLayer("thread-1"));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      expect(setHighlight).not.toHaveBeenCalled();
      expect(deleteHighlight).not.toHaveBeenCalled();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 140));
      });

      expect(setHighlight).toHaveBeenCalled();
    } finally {
      if (root) {
        await act(() => root?.unmount());
        root = null;
      }
      getSelectionSpy.mockRestore();
      (globalThis as { CSS?: unknown }).CSS = originalCss;
      (globalThis as { Highlight?: unknown }).Highlight = originalHighlight;
    }
  });

  it("defers absolute highlight rect recomputation during active selection scroll", async () => {
    const body = document.createElement("div");
    const containerRef = { current: body };
    const textNode = document.createTextNode("Annotated body text.");
    body.appendChild(textNode);
    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, 0);
    selectionRange.setEnd(textNode, "Annotated".length);
    selectionRange.getBoundingClientRect = () => makeRect(12, 24, 64, 18);
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => selectionRange,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 9,
      containerText: "Annotated body text.",
      selectedText: "Annotated",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Annotated", prefix: "", suffix: " body" },
        position: { normalizedStart: 0, normalizedEnd: 9, markdownStart: 0, markdownEnd: 9 },
      },
    });
    root = createRoot(container);

    try {
      await act(async () => {
        root?.render(
          <DocumentAnnotationLayer
            containerRef={containerRef}
            markdown="Annotated body text."
            threads={[
              { id: "thread-1", selectedText: "Annotated", status: "open", anchorState: "active" },
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
      mockRangesForNormalizedSpan.mockClear();

      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      expect(mockRangesForNormalizedSpan).not.toHaveBeenCalled();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 140));
      });

      expect(mockRangesForNormalizedSpan).toHaveBeenCalled();
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it("captures a coarse-pointer selection once after selectionchange settles", async () => {
    mockIsCoarsePointerDevice.mockReturnValue(true);
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(12, 24, 64, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    const onPendingAnchorChange = vi.fn();
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Select this text."
          threads={[]}
          focusedThreadId={null}
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={onPendingAnchorChange}
          onRequestComment={vi.fn()}
        />,
      );
    });

    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(mockGetContainerTextOffset).not.toHaveBeenCalled();
    expect(mockBuildAnchorFromContainerSelection).not.toHaveBeenCalled();
    expect(onPendingAnchorChange).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });

    expect(mockGetContainerTextOffset).toHaveBeenCalledTimes(1);
    expect(mockBuildAnchorFromContainerSelection).toHaveBeenCalledTimes(1);
    expect(onPendingAnchorChange).toHaveBeenCalledTimes(1);
  });

  it("uses the short gesture-end delay and skips unchanged settled selections", async () => {
    mockIsCoarsePointerDevice.mockReturnValue(true);
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(12, 24, 64, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    const onPendingAnchorChange = vi.fn();
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Select this text."
          threads={[]}
          focusedThreadId={null}
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={onPendingAnchorChange}
          onRequestComment={vi.fn()}
        />,
      );
    });

    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockBuildAnchorFromContainerSelection).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(mockBuildAnchorFromContainerSelection).toHaveBeenCalledTimes(1);
    expect(onPendingAnchorChange).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("touchend"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });

    expect(mockGetContainerTextOffset).toHaveBeenCalledTimes(1);
    expect(mockBuildAnchorFromContainerSelection).toHaveBeenCalledTimes(1);
    expect(onPendingAnchorChange).toHaveBeenCalledTimes(1);
  });

  it("places a near-top selection toolbar below the selection and within the viewport", async () => {
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(-40, 2, 40, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    root = createRoot(container);
    let capturedAnchor: React.ComponentProps<typeof DocumentAnnotationLayer>["pendingAnchor"] = null;
    const renderLayer = () => (
      <DocumentAnnotationLayer
        containerRef={{ current: body }}
        markdown="Select this text."
        threads={[]}
        focusedThreadId={null}
        onThreadFocus={vi.fn()}
        pendingAnchor={capturedAnchor}
        onPendingAnchorChange={(anchor) => {
          capturedAnchor = anchor;
        }}
        onRequestComment={vi.fn()}
        testWindow={{ innerWidth: 320, innerHeight: 640 }}
      />
    );

    await act(async () => {
      root?.render(renderLayer());
    });
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => {
      root?.render(renderLayer());
    });

    const toolbar = container.querySelector<HTMLElement>('[data-testid="document-annotation-selection-toolbar"]');
    expect(toolbar?.style.top).toBe("28px");
    expect(toolbar?.style.left).toBe("8px");
  });

  it("places a coarse-pointer selection toolbar below the selection by default", async () => {
    mockIsCoarsePointerDevice.mockReturnValue(true);
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(100, 100, 60, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    root = createRoot(container);
    let capturedAnchor: React.ComponentProps<typeof DocumentAnnotationLayer>["pendingAnchor"] = null;
    const renderLayer = () => (
      <DocumentAnnotationLayer
        containerRef={{ current: body }}
        markdown="Select this text."
        threads={[]}
        focusedThreadId={null}
        onThreadFocus={vi.fn()}
        pendingAnchor={capturedAnchor}
        onPendingAnchorChange={(anchor) => {
          capturedAnchor = anchor;
        }}
        onRequestComment={vi.fn()}
        testWindow={{ innerWidth: 320, innerHeight: 640 }}
      />
    );

    await act(async () => {
      root?.render(renderLayer());
    });
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("touchend"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      root?.render(renderLayer());
    });

    const toolbar = container.querySelector<HTMLElement>('[data-testid="document-annotation-selection-toolbar"]');
    expect(toolbar?.style.top).toBe("130px");
    expect(toolbar?.style.left).toBe("70px");
  });

  it("flips a coarse-pointer selection toolbar above when there is no room below", async () => {
    mockIsCoarsePointerDevice.mockReturnValue(true);
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(100, 590, 60, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    root = createRoot(container);
    let capturedAnchor: React.ComponentProps<typeof DocumentAnnotationLayer>["pendingAnchor"] = null;
    const renderLayer = () => (
      <DocumentAnnotationLayer
        containerRef={{ current: body }}
        markdown="Select this text."
        threads={[]}
        focusedThreadId={null}
        onThreadFocus={vi.fn()}
        pendingAnchor={capturedAnchor}
        onPendingAnchorChange={(anchor) => {
          capturedAnchor = anchor;
        }}
        onRequestComment={vi.fn()}
        testWindow={{ innerWidth: 320, innerHeight: 640 }}
      />
    );

    await act(async () => {
      root?.render(renderLayer());
    });
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("touchend"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      root?.render(renderLayer());
    });

    const toolbar = container.querySelector<HTMLElement>('[data-testid="document-annotation-selection-toolbar"]');
    expect(toolbar?.style.top).toBe("546px");
    expect(toolbar?.style.left).toBe("70px");
  });

  it("uses the settled pending anchor for an explicit shortcut request", async () => {
    const body = document.createElement("div");
    const textNode = document.createTextNode("Select this text.");
    body.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    range.getBoundingClientRect = () => makeRect(12, 24, 64, 18);
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection);
    mockGetContainerTextOffset.mockReturnValue({
      startOffset: 0,
      endOffset: 6,
      containerText: "Select this text.",
      selectedText: "Select",
    });
    mockBuildAnchorFromContainerSelection.mockReturnValue({
      selector: {
        quote: { exact: "Select", prefix: "", suffix: " this" },
        position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 },
      },
    });
    const onRequestComment = vi.fn();
    let pendingAnchor: React.ComponentProps<typeof DocumentAnnotationLayer>["pendingAnchor"] = null;
    const containerRef = { current: body };
    const onPendingAnchorChange = (anchor: React.ComponentProps<typeof DocumentAnnotationLayer>["pendingAnchor"]) => {
      pendingAnchor = anchor;
    };
    root = createRoot(container);
    const renderLayer = (captureSelectionRequestId: number) => (
      <DocumentAnnotationLayer
        containerRef={containerRef}
        markdown="Select this text."
        threads={[]}
        focusedThreadId={null}
        onThreadFocus={vi.fn()}
        pendingAnchor={pendingAnchor}
        onPendingAnchorChange={onPendingAnchorChange}
        onRequestComment={onRequestComment}
        captureSelectionRequestId={captureSelectionRequestId}
      />
    );

    await act(async () => {
      root?.render(renderLayer(0));
    });
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(pendingAnchor).not.toBeNull();
    await act(async () => {
      root?.render(renderLayer(1));
    });

    expect(mockBuildAnchorFromContainerSelection).toHaveBeenCalledTimes(1);
    expect(onRequestComment).toHaveBeenCalledTimes(1);
    expect(onRequestComment).toHaveBeenCalledWith(pendingAnchor);
  });
});
