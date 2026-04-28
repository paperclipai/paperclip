// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
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
    const [content, setContent] = React.useState(markdown);
    const editableRef = React.useRef<HTMLDivElement>(null);
    const handle = React.useMemo(() => ({
      setMarkdown: (value: string) => setContent(value),
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

  it("anchors the mention menu inside the visual viewport when mobile offsets are present", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 180, viewportLeft: 120 },
        { offsetLeft: 24, offsetTop: 320, width: 320, height: 260 },
      ),
    ).toEqual({
      top: 372,
      left: 144,
    });
  });

  it("clamps the mention menu back into view near the viewport edges", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 260, viewportLeft: 240 },
        { offsetLeft: 0, offsetTop: 0, width: 280, height: 220 },
      ),
    ).toEqual({
      top: 12,
      left: 92,
    });
  });

  it("keeps a short mention menu on the same line when it fits below the caret", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 160, viewportLeft: 120 },
        { offsetLeft: 0, offsetTop: 0, width: 320, height: 220 },
        { width: 188, height: 42 },
      ),
    ).toEqual({
      top: 164,
      left: 120,
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

  it("accepts mention selection from touchstart taps", async () => {
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="@Pap"
          onChange={handleChange}
          mentions={[
            {
              id: "project:project-123",
              kind: "project",
              name: "Paperclip App",
              projectId: "project-123",
              projectColor: "#336699",
            },
          ]}
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
      .find((node) => node.textContent?.includes("Paperclip App"));
    expect(option).toBeTruthy();

    act(() => {
      option?.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
    });

    expect(handleChange).toHaveBeenCalledWith(
      `[@Paperclip App](${buildProjectMentionHref("project-123", "#336699")}) `,
    );

    await act(async () => {
      root.unmount();
    });
  });
});
