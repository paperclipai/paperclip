// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectMentionHref, buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import {
  computeMentionMenuPosition,
  findClosestAutocompleteAnchor,
  findMentionMatch,
  isSameAutocompleteSession,
  MarkdownEditor,
  placeCaretAfterMentionAnchor,
  shouldAcceptAutocompleteKey,
} from "./MarkdownEditor";

const mdxEditorMockState = vi.hoisted(() => ({
  emitMountEmptyReset: false,
  emitMountParseError: false,
  emitMountSilentEmptyState: false,
  markdownValues: [] as string[],
  suppressHtmlProcessingValues: [] as boolean[],
  /** Every value pushed through the imperative `setMarkdown` handle. */
  setMarkdownCalls: [] as string[],
  /** Latest `onChange` the editor was rendered with — lets tests simulate an editor-originated edit. */
  lastOnChange: null as ((value: string) => void) | null,
}));

function containsHtmlLikeTag(markdown: string) {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?\/?>/.test(markdown);
}

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");

  function setForwardedRef<T>(ref: React.ForwardedRef<T | null>, value: T | null) {
    if (typeof ref === "function") {
      ref(value);
      return;
    }
    if (ref) {
      (ref as React.MutableRefObject<T | null>).current = value;
    }
  }

  const MDXEditor = React.forwardRef(function MockMDXEditor(
    {
      markdown,
      placeholder,
      onChange,
      onError,
      className,
      suppressHtmlProcessing,
    }: {
      markdown: string;
      placeholder?: string;
      onChange?: (value: string) => void;
      onError?: (error: unknown) => void;
      suppressHtmlProcessing?: boolean;
      className?: string;
    },
    forwardedRef: React.ForwardedRef<{ setMarkdown: (value: string) => void; focus: () => void } | null>,
  ) {
    mdxEditorMockState.markdownValues.push(markdown);
    mdxEditorMockState.suppressHtmlProcessingValues.push(Boolean(suppressHtmlProcessing));
    mdxEditorMockState.lastOnChange = onChange ?? null;
    const [content, setContent] = React.useState(markdown);
    const editableRef = React.useRef<HTMLDivElement>(null);
    const handle = React.useMemo(() => ({
      setMarkdown: (value: string) => {
        mdxEditorMockState.setMarkdownCalls.push(value);
        setContent(value);
      },
      focus: () => editableRef.current?.focus(),
    }), []);

    React.useEffect(() => {
      if (!suppressHtmlProcessing && containsHtmlLikeTag(markdown)) {
        setContent("");
        onError?.({
          error: "Error parsing markdown: HTML-like formatting requires suppressHtmlProcessing",
          source: markdown,
        });
        return;
      }
      setContent(markdown);
    }, [markdown, onError, suppressHtmlProcessing]);

    React.useEffect(() => {
      setForwardedRef(forwardedRef, null);
      const timer = window.setTimeout(() => {
        setForwardedRef(forwardedRef, handle);
        if (mdxEditorMockState.emitMountEmptyReset) {
          setContent("");
          onChange?.("");
        }
        if (mdxEditorMockState.emitMountSilentEmptyState) {
          setContent("");
        }
        if (mdxEditorMockState.emitMountParseError) {
          setContent("");
          onError?.({
            error: "Unsupported markdown syntax",
            source: markdown,
          });
        }
      }, 0);
      return () => {
        window.clearTimeout(timer);
        setForwardedRef(forwardedRef, null);
      };
    }, []);

    return (
      <div
        ref={editableRef}
        data-testid="mdx-editor"
        className={className}
        contentEditable
        suppressContentEditableWarning
      >
        {content || placeholder || ""}
      </div>
    );
  });

  return {
    CodeMirrorEditor: () => null,
    MDXEditor,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    createRootEditorSubscription$: Symbol("createRootEditorSubscription$"),
    headingsPlugin: () => ({}),
    imagePlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    realmPlugin: (plugin: unknown) => plugin,
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

vi.mock("../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

vi.mock("../lib/paste-normalization", () => ({
  pasteNormalizationPlugin: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createFileDragEvent(type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: { types: string[]; files: File[]; dropEffect?: string };
  };
  event.dataTransfer = {
    types: ["Files"],
    files: [],
  };
  return event;
}

describe("MarkdownEditor", () => {
  let container: HTMLDivElement;
  let originalRangeRect: typeof Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    originalRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () => ({
      x: 32,
      y: 24,
      width: 12,
      height: 18,
      top: 24,
      right: 44,
      bottom: 42,
      left: 32,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    container.remove();
    Range.prototype.getBoundingClientRect = originalRangeRect;
    vi.clearAllMocks();
    mdxEditorMockState.emitMountEmptyReset = false;
    mdxEditorMockState.emitMountParseError = false;
    mdxEditorMockState.emitMountSilentEmptyState = false;
    mdxEditorMockState.markdownValues = [];
    mdxEditorMockState.suppressHtmlProcessingValues = [];
    mdxEditorMockState.setMarkdownCalls = [];
    mdxEditorMockState.lastOnChange = null;
  });

  it("applies async external value updates once the editor ref becomes ready", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Loaded plan body"
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    expect(container.textContent).toContain("Loaded plan body");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the external value when the unfocused editor emits an empty mount reset", async () => {
    mdxEditorMockState.emitMountEmptyReset = true;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Loaded plan body"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    expect(container.textContent).toContain("Loaded plan body");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("converts advisory-style html image tags to markdown image syntax before mounting the editor", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value={`Before\n\n<img width="10" height="10" alt="image" src="https://example.com/test.png" />\n\nAfter`}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    expect(mdxEditorMockState.markdownValues.at(-1)).toContain("![image](https://example.com/test.png)");
    expect(mdxEditorMockState.markdownValues.at(-1)).not.toContain("<img");
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps arbitrary HTML-like tags in the rich editor instead of falling back to raw source", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value={'<section data-source="paste">\n## My take\n\n<p>Benchmark notes</p>\n</section>'}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Benchmark notes");
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps scriptable pasted HTML inert in the rich editor", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value={'<script>fetch("/api/secrets")</script>\n<iframe src="https://example.com"></iframe>\n<p onclick="steal()">Plain text</p>'}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("script, iframe, p[onclick]")).toBeNull();
    expect(container.textContent).toContain('fetch("/api/secrets")');
    expect(container.textContent).toContain("Plain text");

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to a raw textarea when the rich parser rejects the markdown", async () => {
    mdxEditorMockState.emitMountParseError = true;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Affected versions: <= v0.3.1"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Affected versions: <= v0.3.1");
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to a raw textarea when the rich editor mounts into the placeholder without callbacks", async () => {
    mdxEditorMockState.emitMountSilentEmptyState = true;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Affected versions: <= v0.3.1"
          onChange={handleChange}
          placeholder="Add a description..."
        />,
      );
    });

    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Affected versions: <= v0.3.1");
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the editor-scoped dropzone by default when files are dragged over it", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          placeholder="Markdown body"
          imageUploadHandler={async () => "https://example.com/image.png"}
        />,
      );
    });

    await flush();

    const scope = container.querySelector('[data-testid="mdx-editor"]')?.parentElement as HTMLDivElement | null;
    expect(scope).not.toBeNull();

    act(() => {
      scope?.dispatchEvent(createFileDragEvent("dragenter"));
    });

    expect(scope?.className).toContain("ring-1");
    expect(container.textContent).toContain("Drop image to upload");

    act(() => {
      scope?.dispatchEvent(createFileDragEvent("dragleave"));
    });

    expect(scope?.className).not.toContain("ring-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("defers file-drop visuals to a parent container when requested", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          placeholder="Markdown body"
          imageUploadHandler={async () => "https://example.com/image.png"}
          fileDropTarget="parent"
        />,
      );
    });

    await flush();

    const scope = container.querySelector('[data-testid="mdx-editor"]')?.parentElement as HTMLDivElement | null;
    expect(scope).not.toBeNull();

    act(() => {
      scope?.dispatchEvent(createFileDragEvent("dragenter"));
    });

    expect(scope?.className).not.toContain("ring-1");
    expect(container.textContent).not.toContain("Drop image to upload");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show the raw fallback while image-only markdown is settling", async () => {
    mdxEditorMockState.emitMountSilentEmptyState = true;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="![Screenshot](/api/attachments/image/content)"
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await flush();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");

    await act(async () => {
      root.unmount();
    });
  });

  it("places the menu top on the caret line and offsets the left a space-width past the caret", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 100, viewportBottom: 118, viewportLeft: 240 },
        { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 },
      ),
    ).toEqual({
      top: 100,
      left: 250,
    });
  });

  it("applies visual viewport offsets when present", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 20, viewportBottom: 38, viewportLeft: 120 },
        { offsetLeft: 24, offsetTop: 320, width: 320, height: 260 },
      ),
    ).toEqual({
      top: 340,
      left: 154,
    });
  });

  it("clamps the mention menu back into view near the viewport edges", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 260, viewportBottom: 278, viewportLeft: 240 },
        { offsetLeft: 0, offsetTop: 0, width: 280, height: 220 },
      ),
    ).toEqual({
      top: 12,
      left: 92,
    });
  });

  it("flips the menu above the caret line when it would overflow below", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 560, viewportBottom: 580, viewportLeft: 200 },
        { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 },
      ),
    ).toEqual({
      top: 372,
      left: 210,
    });
  });

  it("keeps a short mention menu on the same line when it fits below the caret", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 160, viewportBottom: 178, viewportLeft: 120 },
        { offsetLeft: 0, offsetTop: 0, width: 320, height: 220 },
        { width: 188, height: 42 },
      ),
    ).toEqual({
      top: 160,
      left: 130,
    });
  });

  it("keeps mention queries active across spaces", () => {
    expect(findMentionMatch("Ping @Paperclip App", "Ping @Paperclip App".length)).toEqual({
      trigger: "mention",
      marker: "@",
      query: "Paperclip App",
      atPos: 5,
      endPos: "Ping @Paperclip App".length,
    });
  });

  it("still rejects slash commands once spaces are typed", () => {
    expect(findMentionMatch("/open issue", "/open issue".length)).toBeNull();
  });

  it("keeps routine slash queries active across spaces", () => {
    expect(findMentionMatch("/routine:Weekly release review", "/routine:Weekly release review".length)).toEqual({
      trigger: "skill",
      marker: "/",
      query: "routine:Weekly release review",
      atPos: 0,
      endPos: "/routine:Weekly release review".length,
    });
  });

  it("does not treat Enter as skill autocomplete accept", () => {
    expect(shouldAcceptAutocompleteKey("Enter", "skill")).toBe(false);
    expect(shouldAcceptAutocompleteKey("Enter", "skill", true)).toBe(true);
    expect(shouldAcceptAutocompleteKey("Enter", "mention")).toBe(true);
    expect(shouldAcceptAutocompleteKey("Tab", "skill")).toBe(true);
  });

  it("keeps the same autocomplete session active while the slash query is unchanged", () => {
    const textNode = document.createTextNode("/agent");
    expect(isSameAutocompleteSession(
      {
        trigger: "skill",
        marker: "/",
        query: "agent",
        textNode,
        atPos: 0,
        endPos: 6,
      },
      {
        trigger: "skill",
        marker: "/",
        query: "agent",
        textNode,
        atPos: 0,
        endPos: 6,
      },
    )).toBe(true);

    expect(isSameAutocompleteSession(
      {
        trigger: "skill",
        marker: "/",
        query: "agent",
        textNode,
        atPos: 0,
        endPos: 6,
      },
      {
        trigger: "skill",
        marker: "/",
        query: "agent-browser",
        textNode,
        atPos: 0,
        endPos: 14,
      },
    )).toBe(false);
  });

  it("finds skill anchors by mention metadata instead of visible text", () => {
    const editable = document.createElement("div");
    const skillLink = document.createElement("a");
    skillLink.setAttribute("href", buildSkillMentionHref("skill-123", "agent-browser"));
    skillLink.textContent = "/agent-browser ";
    editable.appendChild(skillLink);

    const found = findClosestAutocompleteAnchor(editable, {
      id: "skill:skill-123",
      kind: "skill",
      skillId: "skill-123",
      key: "agent-browser",
      name: "Agent Browser",
      slug: "agent-browser",
      description: null,
      href: buildSkillMentionHref("skill-123", "agent-browser"),
      aliases: ["agent-browser", "Agent Browser"],
    });

    expect(found).toBe(skillLink);
  });

  it("finds routine anchors by mention metadata instead of visible text", () => {
    const editable = document.createElement("div");
    const routineLink = document.createElement("a");
    routineLink.setAttribute("href", buildRoutineMentionHref("routine-123"));
    routineLink.textContent = "/routine:Weekly release review ";
    editable.appendChild(routineLink);

    const found = findClosestAutocompleteAnchor(editable, {
      id: "routine:routine-123",
      kind: "routine",
      routineId: "routine-123",
      name: "Weekly release review",
      status: "active",
      href: buildRoutineMentionHref("routine-123"),
      aliases: ["routine:Weekly release review", "Weekly release review"],
    });

    expect(found).toBe(routineLink);
  });

  it("places the caret after the mention's trailing space when present", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);

    const skillLink = document.createElement("a");
    skillLink.setAttribute("href", buildSkillMentionHref("skill-123", "agent-browser"));
    skillLink.textContent = "/agent-browser";
    const trailingSpace = document.createTextNode(" ");
    editable.append(skillLink, trailingSpace);

    expect(placeCaretAfterMentionAnchor(skillLink)).toBe(true);

    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(trailingSpace);
    expect(selection?.anchorOffset).toBe(1);

    editable.remove();
  });

  function createTouchEvent(
    type: "touchstart" | "touchmove" | "touchend",
    touches: Array<{ clientX: number; clientY: number }>,
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const list = touches as unknown as TouchList;
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
    Object.defineProperty(event, "changedTouches", { value: list });
    return event;
  }

  async function openMentionMenuFor(
    handleChange: ReturnType<typeof vi.fn<(value: string) => void>>,
    mentions = [
      {
        id: "project:project-123",
        kind: "project" as const,
        name: "Paperclip App",
        projectId: "project-123",
        projectColor: "#336699",
      },
    ],
  ): Promise<{ option: HTMLButtonElement; root: ReturnType<typeof createRoot>; menu: HTMLElement }> {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="@Pap"
          onChange={handleChange}
          mentions={mentions}
        />,
      );
    });

    await flush();

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
    const textNode = editable?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode!, "@Pap".length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flush();

    const option = Array.from(document.body.querySelectorAll('button[type="button"]'))
      .find((node) => node.textContent?.includes("Paperclip App")) as HTMLButtonElement | undefined;
    expect(option).toBeTruthy();
    const menu = document.body.querySelector('[data-testid="mention-autocomplete-menu"]') as HTMLElement | null;
    expect(menu).toBeTruthy();
    return { option: option!, root, menu: menu! };
  }

  it("accepts mention selection from a touch tap", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(handleChange);
    const point = { clientX: 100, clientY: 50 };

    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [point]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [point]));
    });

    expect(handleChange).toHaveBeenCalledWith(
      `[@Paperclip App](${buildProjectMentionHref("project-123", "#336699")}) `,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("marks the autocomplete portal as floating UI for modal pointer handling", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(handleChange);

    const menu = option.closest("[data-paperclip-floating-ui]");
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain("pointer-events-auto");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not preventDefault on touchstart so the mention menu can scroll on mobile", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(handleChange);

    const touchstart = createTouchEvent("touchstart", [{ clientX: 100, clientY: 50 }]);
    act(() => {
      option.dispatchEvent(touchstart);
    });

    expect(touchstart.defaultPrevented).toBe(false);
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders all mention matches inside a bounded scroll container", async () => {
    const handleChange = vi.fn();
    const mentions = Array.from({ length: 12 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { menu, root } = await openMentionMenuFor(handleChange, mentions);

    const options = Array.from(menu.querySelectorAll('button[type="button"]'));
    expect(options).toHaveLength(12);
    expect(menu.className).toContain("max-h-[208px]");
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.style.touchAction).toBe("pan-y");

    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    act(() => {
      menu.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("caps rendered mention matches while keeping the menu scrollable", async () => {
    const handleChange = vi.fn();
    const mentions = Array.from({ length: 60 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { menu, root } = await openMentionMenuFor(handleChange, mentions);

    const options = Array.from(menu.querySelectorAll('button[type="button"]'));
    expect(options).toHaveLength(50);
    expect(menu.className).toContain("overflow-y-auto");

    await act(async () => {
      root.unmount();
    });
  });

  it("scrolls the active mention option into view during keyboard navigation", async () => {
    const handleChange = vi.fn();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const mentions = Array.from({ length: 12 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { root } = await openMentionMenuFor(handleChange, mentions);
    scrollIntoView.mockClear();

    const editorScope = container.querySelector('[data-testid="mdx-editor"]')?.parentElement;
    expect(editorScope).toBeTruthy();

    act(() => {
      editorScope?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    await act(async () => {
      root.unmount();
    });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("does not select when the touch moves like a scroll", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(handleChange);
    const start = { clientX: 100, clientY: 50 };
    const moved = { clientX: 100, clientY: 90 };

    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [start]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchmove", [moved]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [moved]));
    });

    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

/**
 * NEO-411 (parent NEO-405): iPhone dictation duplication.
 *
 * On-device evidence (NEO-405 capture log) revised the original diagnosis: iOS
 * dictation emits **no** composition events and **no** `insertReplacementText`.
 * It streams full-range `insertText` replacements, then after a pause replays the
 * whole transcript as a same-tick collapsed-insert burst. The class of bug is a
 * controlled-component race: a `setMarkdown` reconciliation firing mid-input
 * desyncs the editor from the OS input buffer. These guards lock the reconcile
 * invariants — gate reconciliation on the *real* input signal (`beforeinput` /
 * `input` + composition), never swallow a genuine external update, and never let
 * an editor-originated value round-trip back into `setMarkdown`.
 *
 * Note: jsdom cannot reproduce iOS's internal replay, so on-device confirmation
 * that the duplication no longer fires is tracked separately (NEO-405 Phase 4).
 */
describe("MarkdownEditor — dictation reconciliation gate (NEO-411)", () => {
  const SETTLE_PAST_MS = 400; // comfortably past the component's INPUT_SETTLE_MS (350ms)
  let container: HTMLDivElement;

  function Controlled({ initialValue }: { initialValue: string }) {
    const [v, setV] = useState(initialValue);
    return <MarkdownEditor value={v} onChange={(next) => setV(next)} placeholder="Body" />;
  }

  function getEditable(): HTMLElement {
    const editable = container.querySelector('[contenteditable="true"]');
    if (!(editable instanceof HTMLElement)) throw new Error("contenteditable not found");
    return editable;
  }

  function fireInput(editable: HTMLElement, type: "beforeinput" | "input" | "compositionstart" | "compositionend") {
    editable.dispatchEvent(new Event(type, { bubbles: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
    mdxEditorMockState.markdownValues = [];
    mdxEditorMockState.suppressHtmlProcessingValues = [];
    mdxEditorMockState.setMarkdownCalls = [];
    mdxEditorMockState.lastOnChange = null;
  });

  it("never re-invokes setMarkdown for an editor-originated change (no self round-trip)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Controlled initialValue="start" />);
    });
    act(() => {
      vi.advanceTimersByTime(1); // attach the imperative ref
    });
    mdxEditorMockState.setMarkdownCalls = [];

    // The editor emits a user edit; the controlled parent echoes it straight back
    // as the `value` prop. That round-trip must not re-enter the editor.
    act(() => {
      mdxEditorMockState.lastOnChange?.("start typed by user");
    });
    act(() => {
      vi.advanceTimersByTime(SETTLE_PAST_MS);
    });

    expect(mdxEditorMockState.setMarkdownCalls).not.toContain("start typed by user");

    act(() => {
      root.unmount();
    });
  });

  it("defers an external value update during active input and flushes it once input settles", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<MarkdownEditor value="start" onChange={() => {}} placeholder="Body" />);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    mdxEditorMockState.setMarkdownCalls = [];
    const editable = getEditable();

    // iOS dictation streams beforeinput/input — mark input in-flight.
    act(() => {
      fireInput(editable, "beforeinput");
      fireInput(editable, "input");
    });

    // A genuine external/remote value arrives mid-burst.
    act(() => {
      root.render(<MarkdownEditor value="EXTERNAL UPDATE" onChange={() => {}} placeholder="Body" />);
    });

    // Deferred: not yanked into the editor while input is flowing.
    expect(mdxEditorMockState.setMarkdownCalls).not.toContain("EXTERNAL UPDATE");

    // Once input settles the external update flushes — never swallowed.
    act(() => {
      vi.advanceTimersByTime(SETTLE_PAST_MS);
    });
    expect(mdxEditorMockState.setMarkdownCalls).toContain("EXTERNAL UPDATE");

    act(() => {
      root.unmount();
    });
  });

  it("defers reconciliation during desktop IME composition and flushes after it ends", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<MarkdownEditor value="start" onChange={() => {}} placeholder="Body" />);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    mdxEditorMockState.setMarkdownCalls = [];
    const editable = getEditable();

    act(() => {
      fireInput(editable, "compositionstart");
    });
    act(() => {
      root.render(<MarkdownEditor value="外部の更新" onChange={() => {}} placeholder="Body" />);
    });
    expect(mdxEditorMockState.setMarkdownCalls).not.toContain("外部の更新");

    // compositionend re-arms the settle window; still deferred until it elapses.
    act(() => {
      fireInput(editable, "compositionend");
    });
    act(() => {
      vi.advanceTimersByTime(SETTLE_PAST_MS);
    });
    expect(mdxEditorMockState.setMarkdownCalls).toContain("外部の更新");

    act(() => {
      root.unmount();
    });
  });

  it("never reconciles during the iOS two-phase dictation stream + replay (NEO-405 repro)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Controlled initialValue="" />);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const editable = getEditable();
    mdxEditorMockState.setMarkdownCalls = [];

    // Phase A: iOS streams full-range insertText replacements (each supersedes the last).
    const stream = [
      "I",
      "I told them",
      "I told them their package",
      "I told them their packages would arrive to their house too late.",
    ];
    // Phase B: after a pause, iOS replays the whole transcript as collapsed word inserts.
    const replay = [
      "I told them their packages would arrive to their house too late.I",
      "I told them their packages would arrive to their house too late.I told them their packages",
      "I told them their packages would arrive to their house too late.There are two packages over there.",
    ];

    act(() => {
      for (const data of [...stream, ...replay]) {
        fireInput(editable, "beforeinput");
        mdxEditorMockState.lastOnChange?.(data);
        fireInput(editable, "input");
      }
    });

    // Across the whole dictation + replay window, the editor-originated round-trip
    // must never reconcile back into the editor — that desync is the duplication.
    expect(mdxEditorMockState.setMarkdownCalls).toEqual([]);

    act(() => {
      root.unmount();
    });
  });
});
