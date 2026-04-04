// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "./MarkdownEditor";

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
      suppressHtmlProcessing,
    }: {
      markdown: string;
      placeholder?: string;
      suppressHtmlProcessing?: boolean;
    },
    forwardedRef: React.ForwardedRef<{ setMarkdown: (value: string) => void; focus: () => void } | null>,
  ) {
    const [content, setContent] = React.useState(markdown);
    const handle = React.useMemo(() => ({
      setMarkdown: (value: string) => setContent(value),
      focus: () => {},
    }), []);

    React.useEffect(() => {
      setForwardedRef(forwardedRef, handle);
      return () => {
        setForwardedRef(forwardedRef, null);
      };
    }, [handle, forwardedRef]);

    const parsedContent = !suppressHtmlProcessing && /<\S/.test(content) ? "" : content;

    return <div data-testid="mdx-editor">{parsedContent || placeholder || ""}</div>;
  });

  return {
    CodeMirrorEditor: () => null,
    MDXEditor,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    headingsPlugin: () => ({}),
    imagePlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

vi.mock("../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownEditor angle bracket content", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps markdown with angle brackets visible instead of collapsing to the placeholder", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value={`| Metric | Healthy | Red Flag |
| --- | --- | --- |
| Container spin-up time | <30s | >60s |
| Time to first eval | <15 min | >1 hour |`}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    expect(container.textContent).toContain("Container spin-up time");
    expect(container.textContent).toContain("<30s");
    expect(container.textContent).toContain("<15 min");
    expect(container.textContent).not.toBe("Markdown body");

    await act(async () => {
      root.unmount();
    });
  });
});
