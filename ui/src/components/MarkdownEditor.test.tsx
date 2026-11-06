// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { LinkExtension, LinkNode, $isLinkNode, registerLink, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { createEditor, $createParagraphNode, $createTextNode, $createLineBreakNode, $getRoot, $getSelection,
  $isRangeSelection, $isElementNode, $createNodeSelection, $setSelection, DecoratorNode,
  PASTE_COMMAND, COMMAND_PRIORITY_HIGH, type LexicalEditor } from "lexical";
import { registerRichText } from "@lexical/rich-text";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { buildIssueReferenceHref, buildProjectMentionHref, buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import {
  computeMentionMenuPosition,
  findClosestAutocompleteAnchor,
  findMentionMatch,
  isSameAutocompleteSession,
  issueMentionTitle,
  MarkdownEditor,
  type MarkdownEditorRef,
  type MentionOption,
  placeCaretAfterMentionAnchor,
  placeCaretAtEditableEnd,
  shouldAcceptAutocompleteKey,
} from "./MarkdownEditor";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const mdxEditorMockState = vi.hoisted(() => ({
  linkValidator: null as ((url: string) => boolean) | null,
  pluginDefinitions: [] as unknown[],
  emitMountEmptyReset: false,
  emitMountParseError: false,
  emitMountSilentEmptyState: false,
  throwOnRender: false,
  /** Markdown the mock emits through `onChange` once mounted, as the real editor would export it. */
  emitMountChange: null as string | null,
  /** Markdown the mock emits once mounted with MDXEditor's `initialMarkdownNormalize` flag set. */
  emitMountNormalizedMarkdown: null as string | null,
  /** Milliseconds the mock waits before painting its content, to model a slow import. */
  populateDelayMs: 0,
  markdownValues: [] as string[],
  /** Every string handed to the editor's imperative `insertMarkdown`. */
  insertedMarkdownValues: [] as string[],
  suppressHtmlProcessingValues: [] as boolean[],
}));

/**
 * Stand-in for the real importer's HTML tokenizer. MDXEditor runs with
 * `suppressHtmlProcessing`, which *removes* the HTML visitor — so a bare `<`
 * that opens an HTML construct is what throws
 * `UnrecognizedMarkdownConstructError`, regardless of the flag. Only a
 * backslash escape (`\<`) hides the bracket from the parser, which is exactly
 * what `escapeUnsupportedAngleBrackets` produces.
 */
function containsUnescapedHtmlLikeTag(markdown: string) {
  // Consume escape pairs first so `\<` counts as literal text, then look for a
  // surviving `<` that would open an HTML construct.
  return /(?:^|[^\\])(?:\\\\)*<[A-Za-z!/?]/.test(markdown);
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
      plugins,
    }: {
      markdown: string;
      placeholder?: string;
      onChange?: (value: string, initialMarkdownNormalize?: boolean) => void;
      onError?: (error: unknown) => void;
      suppressHtmlProcessing?: boolean;
      plugins?: unknown[];
      className?: string;
    },
    forwardedRef: React.ForwardedRef<{
      setMarkdown: (value: string) => void;
      insertMarkdown: (value: string) => void;
      focus: (callback?: () => void) => void;
    } | null>,
  ) {
    if (mdxEditorMockState.throwOnRender) {
      throw new Error("Rich editor render crashed");
    }
    mdxEditorMockState.pluginDefinitions = plugins ?? [];
    mdxEditorMockState.markdownValues.push(markdown);
    mdxEditorMockState.suppressHtmlProcessingValues.push(Boolean(suppressHtmlProcessing));
    const [content, setContent] = React.useState(markdown);
    const editableRef = React.useRef<HTMLDivElement>(null);
    const onErrorRef = React.useRef(onError);
    onErrorRef.current = onError;
    const handle = React.useMemo(() => ({
      setMarkdown: (value: string) => setContent(value),
      insertMarkdown: (value: string) => {
        mdxEditorMockState.insertedMarkdownValues.push(value);
        // Inserted markdown goes through the same importer as the mounted
        // document, so an unescaped tag fails here in exactly the same way.
        if (containsUnescapedHtmlLikeTag(value)) {
          onErrorRef.current?.({ error: "Unrecognized markdown construct: html", source: value });
          return;
        }
        setContent((previous) => `${previous}${value}`);
      },
      // The real `focus` runs its callback once a selection exists.
      focus: (callback?: () => void) => {
        editableRef.current?.focus();
        callback?.();
      },
    }), []);

    React.useEffect(() => {
      if (containsUnescapedHtmlLikeTag(markdown)) {
        setContent("");
        onError?.({
          error: "Unrecognized markdown construct: html",
          source: markdown,
        });
        return;
      }
      if (mdxEditorMockState.populateDelayMs > 0) {
        // Model an import that paints its content some time after mount.
        setContent("");
        const timer = window.setTimeout(() => setContent(markdown), mdxEditorMockState.populateDelayMs);
        return () => window.clearTimeout(timer);
      }
      setContent(markdown);
    }, [markdown, onError]);

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
        if (mdxEditorMockState.emitMountChange !== null) {
          onChange?.(mdxEditorMockState.emitMountChange);
        }
        if (mdxEditorMockState.emitMountNormalizedMarkdown !== null) {
          setContent(mdxEditorMockState.emitMountNormalizedMarkdown);
          onChange?.(mdxEditorMockState.emitMountNormalizedMarkdown, true);
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
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            setContent("");
            onChange?.("");
          }
        }}
        onInput={(event) => {
          const next = event.currentTarget.textContent ?? "";
          setContent(next);
          onChange?.(next);
        }}
      >
        {/* The real editor paints resolved text, never the escapes that carried it in. */}
        {content.replace(/\\</g, "<") || placeholder || ""}
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
    linkPlugin: (options: { validateUrl: (url: string) => boolean }) => {
      mdxEditorMockState.linkValidator = options.validateUrl;
      return {};
    },
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    realmPlugin: (plugin: unknown) => () => plugin,
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

vi.mock("../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickRetryRichEditor(scope: HTMLElement) {
  const button = Array.from(scope.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Retry rich editor"),
  );
  if (!button) throw new Error('"Retry rich editor" button not found');
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function fallbackCode(scope: HTMLElement) {
  return scope.querySelector('[data-testid="markdown-editor-fallback-code"]')?.textContent;
}

/**
 * The DOM-empty heuristic checks at 100ms and confirms 200ms later, so a test
 * that wants to prove no fallback happened has to outlast both phases.
 */
async function waitPastEmptyHeuristic() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

function createFileDragEvent(type: string) {
  const event = (
    typeof DragEvent === "function"
      ? new DragEvent(type, { bubbles: true, cancelable: true })
      : new Event(type, { bubbles: true, cancelable: true })
  ) as Event & {
    dataTransfer: { types: string[]; files: File[]; dropEffect?: string };
  };
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: {
      types: ["Files"],
      files: [],
    },
  });
  return event;
}

describe("issueMentionTitle", () => {
  it("strips the leading identifier from the mention name", () => {
    expect(
      issueMentionTitle({
        id: "issue:1",
        kind: "issue",
        name: "PAP-102 @task references",
        issueIdentifier: "PAP-102",
      }),
    ).toBe("@task references");
  });

  it("returns the full name when there is no separate title", () => {
    expect(
      issueMentionTitle({
        id: "issue:1",
        kind: "issue",
        name: "PAP-7",
        issueIdentifier: "PAP-7",
      }),
    ).toBe("");
  });

  it("falls back to the name when the identifier is missing", () => {
    expect(
      issueMentionTitle({ id: "issue:1", kind: "issue", name: "Some task" }),
    ).toBe("Some task");
  });
});

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
    vi.unstubAllGlobals();
    mdxEditorMockState.linkValidator = null;
    mdxEditorMockState.pluginDefinitions = [];
    mdxEditorMockState.emitMountEmptyReset = false;
    mdxEditorMockState.emitMountParseError = false;
    mdxEditorMockState.emitMountSilentEmptyState = false;
    mdxEditorMockState.throwOnRender = false;
    mdxEditorMockState.emitMountChange = null;
    mdxEditorMockState.emitMountNormalizedMarkdown = null;
    mdxEditorMockState.populateDelayMs = 0;
    mdxEditorMockState.markdownValues = [];
    mdxEditorMockState.insertedMarkdownValues = [];
    mdxEditorMockState.suppressHtmlProcessingValues = [];
  });

  it.each([false, true])("handles submission, newlines, and IME confirmation (raw fallback=%s)", async (fallback) => {
    mdxEditorMockState.emitMountParseError = fallback;
    const onSubmit = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="hello" onChange={() => {}} onSubmit={onSubmit} submitKey="enter" />);
    });
    await flush();
    if (fallback) {
      await vi.waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());
    }
    const input = container.querySelector(fallback ? "textarea" : '[contenteditable="true"]')!;
    for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifiers });
      await act(() => { input.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(() => { input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });

  it("keeps ordinary document editors on Command/Ctrl+Enter", async () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    await act(async () => { root.render(<MarkdownEditor value="hello" onChange={() => {}} onSubmit={onSubmit} />); });
    await flush();
    const input = container.querySelector('[contenteditable="true"]')!;
    await act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true })); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
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

  async function createSelectedTextPasteHarness() {
    class ClipboardData {
      private data = new Map<string, string>();
      get types() { return [...this.data.keys()]; }
      setData(type: string, value: string) { this.data.set(type === "text" ? "text/plain" : type, value); }
      getData(type: string) { return this.data.get(type === "text" ? "text/plain" : type) ?? ""; }
    }
    class ClipboardEvent extends Event {
      readonly clipboardData: DataTransfer | null;
      constructor(type: string, options: ClipboardEventInit = {}) {
        super(type, options);
        this.clipboardData = options.clipboardData ?? null;
      }
    }
    vi.stubGlobal("ClipboardEvent", ClipboardEvent);
    vi.stubGlobal("DataTransfer", ClipboardData);
    const root = createRoot(container);
    await act(async () => root.render(<MarkdownEditor value={'{"status":"pending"}'} onChange={vi.fn()} />));
    await flush();
    const validator = mdxEditorMockState.linkValidator;
    if (!validator || !LinkExtension.build) throw new Error("Production link policy was not registered");
    class InlineMediaNode extends DecoratorNode<null> {
      static getType() { return "test-inline-media"; }
      static clone(node: InlineMediaNode) { return new InlineMediaNode(node.getKey()); }
      createDOM() { return document.createElement("img"); }
      updateDOM() { return false; }
      decorate() { return null; }
      isInline() { return true; }
    }
    const editor = createEditor({ namespace: "selected-text-paste", nodes: [LinkNode, InlineMediaNode], onError(error) { throw error; } });
    const stores = LinkExtension.build(editor, { validateUrl: validator, attributes: undefined }, undefined as never);
    const unregister = [registerLink(editor, stores)];
    for (const definition of mdxEditorMockState.pluginDefinitions) {
      const plugin = definition as { init?: (realm: { pub: (signal: unknown, subscriptions: Array<(editor: LexicalEditor) => () => void>) => void }) => void };
      plugin.init?.({ pub: (_signal, subscriptions) => {
        for (const subscription of subscriptions) unregister.push(subscription(editor));
      } });
    }
    unregister.push(registerRichText(editor));
    return {
      editor,
      paste(text: string, softBreak = false, html?: string) {
        const data = new DataTransfer(); data.setData("text/plain", text);
        if (html) data.setData("text/html", html);
        const event = new ClipboardEvent("paste", { clipboardData: data, cancelable: true });
        editor.update(() => {
          const node = $createTextNode('{"status":"pending"}');
          $getRoot().clear().append($createParagraphNode().append(node));
          node.select(0, node.getTextContentSize());
          if (softBreak) {
            const ending = $createTextNode("second line");
            node.getParentOrThrow().append($createLineBreakNode(), ending);
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) throw new Error("Expected range");
            selection.focus.set(ending.getKey(), ending.getTextContentSize(), "text");
          }
          editor.dispatchCommand(PASTE_COMMAND, event);
        }, { discrete: true });
        return editor.getEditorState().read(() => ({ text: $getRoot().getTextContent(),
          links: $getRoot().getAllTextNodes().map(node => node.getParent()).filter($isLinkNode).map(node => node.getURL()) }));
      },
      formats() { return editor.getEditorState().read(() => $getRoot().getAllTextNodes().map(node => ({ text: node.getTextContent(), bold: node.hasFormat("bold") }))); },
      yieldsPaste(kind: "files" | "collapsed" | "token" | "decorator") {
        const data = new DataTransfer(); data.setData("text/plain", "replacement words");
        if (kind === "files") data.setData("Files", "image.png");
        const event = new ClipboardEvent("paste", { clipboardData: data, cancelable: true });
        let forwarded = false;
        const remove = editor.registerCommand(PASTE_COMMAND, received => {
          forwarded = received === event;
          return true;
        }, COMMAND_PRIORITY_HIGH);
        try {
          editor.update(() => {
            const node = kind === "decorator" ? new InlineMediaNode() : $createTextNode("keep this");
            $getRoot().clear().append($createParagraphNode().append(node));
            if (node instanceof InlineMediaNode) {
              const selection = $createNodeSelection(); selection.add(node.getKey()); $setSelection(selection);
            } else {
              if (kind === "token") node.setMode("token");
              node.select(0, kind === "collapsed" ? 0 : node.getTextContentSize());
            }
            editor.dispatchCommand(PASTE_COMMAND, event);
          }, { discrete: true });
          return { forwarded, prevented: event.defaultPrevented };
        } finally { remove(); }
      },
      link(url: string, payload: "string" | "object", decorator: boolean) {
        let handled = false;
        editor.update(() => {
          const node = decorator ? new InlineMediaNode() : $createTextNode("link label");
          $getRoot().clear().append($createParagraphNode().append(node));
          if (decorator) {
            const selection = $createNodeSelection(); selection.add(node.getKey()); $setSelection(selection);
          } else if (node instanceof InlineMediaNode) throw new Error("Expected text");
          else node.select(0, node.getTextContentSize());
          handled = editor.dispatchCommand(TOGGLE_LINK_COMMAND, payload === "string" ? url : { url, title: "Report" });
        }, { discrete: true });
        return editor.getEditorState().read(() => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          const links = $isElementNode(paragraph) ? paragraph.getChildren().filter($isLinkNode) : [];
          return { handled, links: links.map(node => ({ url: node.getURL(), href: node.sanitizeUrl(node.getURL()) })) };
        });
      },
      async close() {
        for (const cleanup of unregister.reverse()) cleanup();
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
      },
    };
  }

  it.each(['{"status":"ready","items":[1,2]}', '{"email":"user@example.test"}', "replacement words", "first line\nsecond line", "/workspace/report.json", "reports/status.md", "#document-report", "v1.2.3", "https://", "www."])(
    "replaces selected text through the real paste command for %j", async replacement => {
      const harness = await createSelectedTextPasteHarness();
      try { expect(harness.paste(replacement)).toEqual({ text: replacement, links: [] }); }
      finally { await harness.close(); }
    },
  );

  it("replaces selected text across a soft line break", async () => {
    const harness = await createSelectedTextPasteHarness();
    try { expect(harness.paste('{"status":"ready"}', true)).toEqual({ text: '{"status":"ready"}', links: [] }); }
    finally { await harness.close(); }
  });

  it("replaces selected text with rich HTML through the native paste owner", async () => {
    const harness = await createSelectedTextPasteHarness();
    const replacement = '{"email":"user@example.test"}';
    try {
      expect(harness.paste(replacement, false, `<strong>${replacement}</strong>`)).toEqual({ text: replacement, links: [] });
      expect(harness.formats()).toEqual([{ text: replacement, bold: true }]);
    } finally { await harness.close(); }
  });

  it("keeps a genuine URL from an HTML clipboard as an intentional link", async () => {
    const harness = await createSelectedTextPasteHarness();
    const url = "https://example.test/report";
    try { expect(harness.paste(url, false, `<a href="${url}">${url}</a>`)).toEqual({ text: '{"status":"pending"}', links: [url] }); }
    finally { await harness.close(); }
  });

  it.each(["https://example.test/report?q=1#section", "http://example.test", "//cdn.example.test/image.png", "www.example.test", "mailto:user@example.test", "user@example.test", "user+updates@sub.example.test", "user@bücher.de", "josé@example.test"])(
    "keeps selected-text URL paste as an intentional link (%s)", async url => {
      const harness = await createSelectedTextPasteHarness();
      try { expect(harness.paste(url)).toEqual({ text: '{"status":"pending"}', links: [url] }); }
      finally { await harness.close(); }
    },
  );

  it.each(["files", "collapsed", "token", "decorator"] as const)(
    "leaves %s paste with its existing handler", async kind => {
      const harness = await createSelectedTextPasteHarness();
      try { expect(harness.yieldsPaste(kind)).toEqual({ forwarded: true, prevented: false }); }
      finally { await harness.close(); }
    },
  );

  it.each(["/issues/TEST-1#document-report", "reports/status.md", "../report.md", "#document-report", "mailto:user@example.test"])(
    "preserves manual and decorator link destination %s", async url => {
      const harness = await createSelectedTextPasteHarness();
      try {
        expect(harness.link(url, "object", false)).toEqual({ handled: true, links: [{ url, href: url === "reports/status.md" ? "https://reports/status.md" : url }] });
        expect(harness.link(url, "string", true)).toEqual({ handled: true, links: [{ url, href: url === "reports/status.md" ? "https://reports/status.md" : url }] });
      } finally { await harness.close(); }
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "vbscript:unsafe"])(
    "preserves executable link guards for %s", async url => {
      const harness = await createSelectedTextPasteHarness();
      try {
        expect(harness.link(url, "string", true)).toEqual({ handled: false, links: [] });
        expect(harness.link(url, "object", false)).toEqual({ handled: true, links: [{ url, href: "about:blank" }] });
      } finally { await harness.close(); }
    },
  );

  it("allows a user to clear loaded text as the first editor change", async () => {
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="Loaded draft" onChange={handleChange} />);
    });
    await flush();
    expect(handleChange).not.toHaveBeenCalled();

    const editor = container.querySelector('[contenteditable="true"]')!;
    await act(async () => {
      editor.textContent = "";
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }));
    });
    expect(handleChange).toHaveBeenCalledExactlyOnceWith("");

    await act(async () => root.unmount());
  });

  it.each(["Delete", "Backspace"])("allows first-change clearing when Lexical handles %s without an input event", async (key) => {
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="Loaded draft" onChange={handleChange} />);
    });
    await flush();
    const editor = container.querySelector('[contenteditable="true"]')!;
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
    expect(handleChange).toHaveBeenCalledExactlyOnceWith("");
    await act(async () => root.unmount());
  });

  it("does not recreate the mention decoration observer when the external value changes", async () => {
    const originalMutationObserver = globalThis.MutationObserver;

    class MockMutationObserver implements MutationObserver {
      static instances: MockMutationObserver[] = [];

      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      readonly takeRecords = vi.fn<() => MutationRecord[]>(() => []);

      constructor(readonly callback: MutationCallback) {
        MockMutationObserver.instances.push(this);
      }
    }

    vi.stubGlobal("MutationObserver", MockMutationObserver);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <MarkdownEditor
            value="First value"
            onChange={() => {}}
            placeholder="Markdown body"
          />,
        );
      });

      await flush();
      const editable = container.querySelector('[contenteditable="true"]');
      expect(editable).not.toBeNull();
      const mentionObserverCountAfterInitialRender = MockMutationObserver.instances.filter(
        (observer) => observer.observe.mock.calls.some(([target]) => target === editable),
      ).length;

      await act(async () => {
        root.render(
          <MarkdownEditor
            value="Updated value"
            onChange={() => {}}
            placeholder="Markdown body"
          />,
        );
      });

      await flush();

      // A separate rich-editor health observer is expected to recreate when the
      // controlled value changes. This assertion only covers the mention
      // decoration observer that attaches to the editable element itself.
      expect(
        MockMutationObserver.instances.filter(
          (observer) => observer.observe.mock.calls.some(([target]) => target === editable),
        ),
      ).toHaveLength(mentionObserverCountAfterInitialRender);
    } finally {
      await act(async () => {
        root.unmount();
      });
      vi.stubGlobal("MutationObserver", originalMutationObserver);
    }
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
    expect(fallbackCode(container)).toBe("MDE-PARSE");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to a raw textarea when the rich editor crashes during render", async () => {
    mdxEditorMockState.throwOnRender = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="5. python3 circleback/sync_insights.py --input <tmp> -- writes insights/<group>/*.md"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("5. python3 circleback/sync_insights.py --input <tmp> -- writes insights/<group>/*.md");
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(fallbackCode(container)).toBe("MDE-RENDER");
    expect(consoleError).toHaveBeenCalledWith(
      "Markdown rich editor failed; falling back to raw textarea",
      expect.objectContaining({
        error: expect.any(Error),
        componentStack: expect.any(String),
      }),
    );
    consoleError.mockRestore();
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
    expect(fallbackCode(container)).toBe("MDE-EMPTY");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps prose with bare angle brackets in the rich editor", async () => {
    const value = "Affected versions: <= v0.3.1\n\nRename <name> to the real name.";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value={value} onChange={handleChange} placeholder="Markdown body" />,
      );
    });

    await flush();
    await waitPastEmptyHeuristic();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");

    // The editor is handed the escaped form: the placeholder is hidden from the
    // HTML tokenizer, while `<=` cannot open a tag and is left exactly as typed.
    const received = mdxEditorMockState.markdownValues.at(-1);
    expect(received).toContain("Rename \\<name> to the real name.");
    expect(received).toContain("Affected versions: <= v0.3.1");

    // What the user sees is still the markdown they wrote.
    expect(container.textContent).toContain("Rename <name> to the real name.");
    expect(handleChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not report MDXEditor's initial markdown normalization as a change", async () => {
    // MDXEditor rewrites `-` bullets to `*` on load and flags it as normalization.
    mdxEditorMockState.emitMountNormalizedMarkdown = "* first\n* second";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value={"- first\n- second"} onChange={handleChange} placeholder="Markdown body" />,
      );
    });

    await flush();
    await waitPastEmptyHeuristic();

    expect(handleChange).not.toHaveBeenCalled();
    // The editor keeps its normalized document; nothing pushes the original back.
    expect(container.textContent).toContain("* first");
    expect(container.querySelector("textarea")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("returns editor output to the parent with the transport escaping removed", async () => {
    const value = "Affected versions: <= v0.3.1\n\nRename <name> to the real name.";
    // What the real exporter emits for this document: `<` re-escaped, `<=` bare.
    mdxEditorMockState.emitMountChange =
      "Affected versions: <= v0.3.1\n\nRename \\<name> to the real name.";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value={value} onChange={handleChange} placeholder="Markdown body" />,
      );
    });

    await flush();

    // The parent stores the clean form — these fields feed agent prompts, so a
    // stray `\<` would leak into a prompt.
    expect(handleChange).toHaveBeenCalledWith(value);
    expect(handleChange.mock.calls.every(([next]) => !String(next).includes("\\<"))).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it.each([
    ["Steer the current turn&#x20;", "Steer the current turn "],
    ["Steer the current turn &#x20;\n", "Steer the current turn  \n"],
    ["Use `&#x20;`&#x20;", "Use `&#x20;` "],
    ["Use \\&#x20;", "Use \\&#x20;"],
    ["```text\n&#x20;", "```text\n&#x20;"],
    ["    &#x20;", "    &#x20;"],
  ])("stores trailing editor spaces without changing literal entities: %s", async (exported, stored) => {
    mdxEditorMockState.emitMountChange = exported;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownEditor value="Draft" onChange={handleChange} />);
    });
    await flush();

    expect(handleChange).toHaveBeenCalledWith(stored);

    await act(async () => {
      root.unmount();
    });
  });

  it("stores intraword underscores as typed instead of the exporter's escaped form", async () => {
    const value = "Your final answer must be exactly E2E_ASK_12_journey_1793913565974_507b01b8.";
    // The real exporter escapes every literal underscore, including inside words.
    mdxEditorMockState.emitMountChange =
      "Your final answer must be exactly E2E\\_ASK\\_12\\_journey\\_1793913565974\\_507b01b8.";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value={value} onChange={handleChange} placeholder="Markdown body" />,
      );
    });

    await flush();

    expect(handleChange).toHaveBeenCalledWith(value);
    expect(handleChange.mock.calls.every(([next]) => !String(next).includes("\\_"))).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("round-trips code with its backslashes while storing prose underscores as typed", async () => {
    const stored = "Run snake_case:\n\n```py\nprint('a\\_b')\n```\n\nThen `keep\\_this` and \\_\\_init\\_\\_.";
    // The exporter escapes the prose underscore; code and the boundary run are as typed.
    mdxEditorMockState.emitMountChange =
      "Run snake\\_case:\n\n```py\nprint('a\\_b')\n```\n\nThen `keep\\_this` and \\_\\_init\\_\\_.";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownEditor value={stored} onChange={handleChange} placeholder="Markdown body" />);
    });

    await flush();

    expect(handleChange).toHaveBeenCalledWith(stored);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps a code span after an escaped HTML-like tag byte-identical", async () => {
    const stored = "<div>\n`a\\_b` and snake_case";
    // The exporter escapes the `<` (reversed on storage) and the prose underscore.
    mdxEditorMockState.emitMountChange = "\\<div>\n`a\\_b` and snake\\_case";
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownEditor value={stored} onChange={handleChange} placeholder="Markdown body" />);
    });

    await flush();

    expect(handleChange).toHaveBeenCalledWith(stored);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not notify the parent when a prop sync echoes escaped markdown back", async () => {
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value="" onChange={handleChange} placeholder="Markdown body" />,
      );
    });

    // The editor echoes an imperative `setMarkdown` back through `onChange` in
    // editor space, while the component compares in stored space.
    mdxEditorMockState.emitMountChange = "Rename \\<name> here";

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Rename <name> here"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await waitPastEmptyHeuristic();

    expect(handleChange).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("recovers the rich editor on retry after a transient parse failure", async () => {
    mdxEditorMockState.emitMountParseError = true;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Rename <name> to the real name."
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    expect(fallbackCode(container)).toBe("MDE-PARSE");

    // The failure was transient; the next mount imports the same markdown fine.
    mdxEditorMockState.emitMountParseError = false;

    await act(async () => {
      clickRetryRichEditor(container);
    });
    await flush();
    await waitPastEmptyHeuristic();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");
    expect(container.textContent).toContain("Rename <name> to the real name.");
    expect(handleChange).not.toHaveBeenCalledWith("");

    await act(async () => {
      root.unmount();
    });
  });

  it("re-arms the empty-onChange guard when the editor is retried", async () => {
    // The sequence this guards: the editor mounts, reports an edit (spending the
    // one-shot mount guard), then fails. The user retries, and the fresh mount
    // emits the empty onChange that the guard exists to swallow — which would
    // otherwise wipe the parent's value.
    mdxEditorMockState.emitMountChange = "Rename \\<name> to the real name.";
    mdxEditorMockState.emitMountParseError = true;
    const handleChange = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Rename <name> to the real name."
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });

    mdxEditorMockState.emitMountChange = null;
    mdxEditorMockState.emitMountParseError = false;
    mdxEditorMockState.emitMountEmptyReset = true;

    await act(async () => {
      clickRetryRichEditor(container);
    });
    await flush();
    await waitPastEmptyHeuristic();

    expect(handleChange).not.toHaveBeenCalledWith("");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Rename <name> to the real name.");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not fall back again while a retried editor is still populating", async () => {
    mdxEditorMockState.emitMountParseError = true;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Rename <name> to the real name."
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });

    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });

    // The retried editor paints its content between the first check and the
    // confirming re-check, so the heuristic must not call it empty.
    mdxEditorMockState.emitMountParseError = false;
    mdxEditorMockState.populateDelayMs = 150;

    await act(async () => {
      clickRetryRichEditor(container);
    });
    await flush();
    await waitPastEmptyHeuristic();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");
    expect(container.textContent).toContain("Rename <name> to the real name.");

    await act(async () => {
      root.unmount();
    });
  });

  it("escapes angle brackets in markdown inserted through the ref", async () => {
    const editorRef = { current: null as MarkdownEditorRef | null };
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          ref={editorRef}
          value="Intro."
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();

    await act(async () => {
      editorRef.current?.insertMarkdown("\n\nRename <name> to the real name.");
    });
    await flush();
    await waitPastEmptyHeuristic();

    expect(mdxEditorMockState.insertedMarkdownValues).toEqual([
      "\n\nRename \\<name> to the real name.",
    ]);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");

    await act(async () => {
      root.unmount();
    });
  });

  it("handles Markdown paste once before the inner editor receives it", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="" onChange={() => {}} />);
    });
    await flush();
    const editable = container.querySelector('[data-testid="mdx-editor"]')!;
    const innerPaste = vi.fn();
    editable.addEventListener("paste", innerPaste);
    const pasted = '```json\n{"content":"nonce\\n"}\n```';
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], getData: () => pasted },
    });
    await act(async () => { editable.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(mdxEditorMockState.insertedMarkdownValues).toEqual([pasted]);
    expect(innerPaste).not.toHaveBeenCalled();

    const dashed = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(dashed, "clipboardData", {
      value: { types: ["text/plain"], getData: () => "- a single dashed line" },
    });
    await act(async () => { editable.dispatchEvent(dashed); });
    expect(dashed.defaultPrevented).toBe(true);
    expect(mdxEditorMockState.insertedMarkdownValues).toEqual([
      pasted,
      "- a single dashed line",
    ]);

    const plain = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(plain, "clipboardData", {
      value: { types: ["text/plain"], getData: () => "ordinary text" },
    });
    await act(async () => { editable.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
    expect(innerPaste).toHaveBeenCalledOnce();
    await act(async () => { root.unmount(); });
  });

  it("leaves a markdown paste inside a nested code block", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="```txt\n\n```" onChange={() => {}} />);
    });
    await flush();

    const editable = container.querySelector('[data-testid="mdx-editor"]') as HTMLDivElement;
    const code = document.createElement("div");
    code.className = "cm-content";
    code.setAttribute("contenteditable", "true");
    const text = document.createTextNode("");
    code.appendChild(text);
    editable.appendChild(code);

    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    code.focus();

    const pasted = "- keep this line in the code block\n- and this one";
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      configurable: true,
      value: {
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? pasted : ""),
      },
    });
    const innerPaste = vi.fn();
    code.addEventListener("paste", innerPaste);

    await act(async () => {
      code.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(mdxEditorMockState.insertedMarkdownValues).toEqual([]);
    expect(innerPaste).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
  });

  it("escapes angle brackets in pasted markdown", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor value="Intro." onChange={() => {}} placeholder="Markdown body" />,
      );
    });
    await flush();

    const scope = container.querySelector('[data-testid="mdx-editor"]')?.parentElement;
    const pasted = "## Setup\n\n- Rename <name> to the real name\n";
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      configurable: true,
      value: {
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? pasted : ""),
      },
    });

    await act(async () => {
      scope?.dispatchEvent(event);
    });
    await flush();
    await waitPastEmptyHeuristic();

    expect(mdxEditorMockState.insertedMarkdownValues).toEqual([
      "## Setup\n\n- Rename \\<name> to the real name\n",
    ]);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");

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

    await act(async () => {
      scope?.dispatchEvent(createFileDragEvent("dragenter"));
    });
    await flush();

    expect(scope?.className).toContain("ring-1");
    expect(container.textContent).toContain("Drop image to upload");

    await act(async () => {
      scope?.dispatchEvent(createFileDragEvent("dragleave"));
    });
    await flush();

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
      maxWidth: 542,
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
      maxWidth: 182,
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
      maxWidth: 180,
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
      maxWidth: 582,
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
      maxWidth: 182,
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

  it("places the caret after a plain action command", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.textContent = "/goal\u00a0";
    document.body.appendChild(editable);

    expect(placeCaretAtEditableEnd(editable)).toBe(true);

    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(editable);
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
    handleChange: Mock<(value: string) => void>,
    mentions: MentionOption[] = [
      {
        id: "project:project-123",
        kind: "project" as const,
        name: "Paperclip App",
        projectId: "project-123",
        projectColor: "#336699",
      },
    ],
    matchText = "Paperclip App",
    onSubmit?: () => void,
  ): Promise<{ option: HTMLButtonElement; root: ReturnType<typeof createRoot>; menu: HTMLElement }> {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MarkdownEditor
          value="@Pap"
          onChange={handleChange}
          mentions={mentions}
          onSubmit={onSubmit}
          submitKey="enter"
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
      .find((node) => node.textContent?.includes(matchText)) as HTMLButtonElement | undefined;
    expect(option).toBeTruthy();
    const menu = document.body.querySelector('[data-testid="mention-autocomplete-menu"]') as HTMLElement | null;
    expect(menu).toBeTruthy();
    return { option: option!, root, menu: menu! };
  }

  it("accepts a mention on Enter before submitting the message", async () => {
    const onSubmit = vi.fn();
    const handleChange = vi.fn();
    const { root } = await openMentionMenuFor(handleChange, undefined, undefined, onSubmit);
    const editable = container.querySelector('[contenteditable="true"]')!;
    const shiftEnter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    await act(() => { editable.dispatchEvent(shiftEnter); });
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(handleChange).not.toHaveBeenCalled();
    await act(() => { editable.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(handleChange).toHaveBeenCalled();
    await act(() => { root.unmount(); });
  });

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

  it("inserts a compact issue link when an @task reference is selected", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(
      handleChange,
      [
        {
          id: "issue:issue-1",
          kind: "issue" as const,
          name: "PAP-102 @task references",
          issueId: "issue-1",
          issueIdentifier: "PAP-102",
        },
      ],
      "PAP-102",
    );
    const point = { clientX: 100, clientY: 50 };

    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [point]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [point]));
    });

    expect(handleChange).toHaveBeenCalledWith(
      `[PAP-102](${buildIssueReferenceHref("PAP-102")}) `,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the task tag and identifier for issue mention options", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(
      handleChange,
      [
        {
          id: "issue:issue-1",
          kind: "issue" as const,
          name: "PAP-102 @task references",
          issueId: "issue-1",
          issueIdentifier: "PAP-102",
        },
      ],
      "PAP-102",
    );

    expect(option.textContent).toContain("PAP-102");
    expect(option.textContent).toContain("@task references");
    expect(option.textContent).toContain("Task");

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
    expect(menu.className).toContain("max-h-(--sz-208px)");
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

  it("lets wheel and touch scrolling reach the autocomplete menu inside a modal", async () => {
    const root = createRoot(container);
    const mentions = Array.from({ length: 12 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));

    await act(async () => {
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Create task</DialogTitle>
            <MarkdownEditor value="@Pap" onChange={() => {}} mentions={mentions} />
          </DialogContent>
        </Dialog>,
      );
    });
    await flush();

    const editable = document.body.querySelector('[data-testid="mdx-editor"]');
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

    const menu = document.body.querySelector('[data-testid="mention-autocomplete-menu"]');
    expect(menu).toBeTruthy();

    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    act(() => {
      menu?.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);

    const touchMove = createTouchEvent("touchmove", [{ clientX: 100, clientY: 90 }]);
    act(() => {
      menu?.firstElementChild?.dispatchEvent(touchMove);
    });
    expect(touchMove.defaultPrevented).toBe(false);

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
