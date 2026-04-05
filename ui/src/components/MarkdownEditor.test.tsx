// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeMentionMenuPosition, MarkdownEditor } from "./MarkdownEditor";

const mdxEditorMockState = vi.hoisted(() => ({
  emitMountEmptyReset: false,
}));

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
    }: {
      markdown: string;
      placeholder?: string;
      onChange?: (value: string) => void;
    },
    forwardedRef: React.ForwardedRef<{ setMarkdown: (value: string) => void; focus: () => void } | null>,
  ) {
    const [content, setContent] = React.useState(markdown);
    const handle = React.useMemo(() => ({
      setMarkdown: (value: string) => setContent(value),
      focus: () => {},
    }), []);

    React.useEffect(() => {
      setForwardedRef(forwardedRef, null);
      const timer = window.setTimeout(() => {
        setForwardedRef(forwardedRef, handle);
        if (mdxEditorMockState.emitMountEmptyReset) {
          setContent("");
          onChange?.("");
        }
      }, 0);
      return () => {
        window.clearTimeout(timer);
        setForwardedRef(forwardedRef, null);
      };
    }, []);

    return <div data-testid="mdx-editor">{content || placeholder || ""}</div>;
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

describe("MarkdownEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
    mdxEditorMockState.emitMountEmptyReset = false;
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
});
