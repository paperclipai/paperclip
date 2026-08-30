// @vitest-environment jsdom

import { flushSync } from "react-dom";
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
  shouldAcceptAutocompleteKey,
} from "./MarkdownEditor";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const mdxEditorMockState = vi.hoisted(() => ({
  emitMountEmptyReset: false,
  emitMountParseError: false,
  emitMountSilentEmptyState: false,
  throwOnRender: false,
  /** Markdown the mock emits through `onChange` once mounted, as the real editor would export it. */
  emitMountChange: null as string | null,
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
    }: {
      markdown: string;
      placeholder?: string;
      onChange?: (value: string) => void;
      onError?: (error: unknown) => void;
      suppressHtmlProcessing?: boolean;
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
    mdxEditorMockState.emitMountEmptyReset = false;
    mdxEditorMockState.emitMountParseError = false;
    mdxEditorMockState.emitMountSilentEmptyState = false;
    mdxEditorMockState.throwOnRender = false;
    mdxEditorMockState.emitMountChange = null;
    mdxEditorMockState.populateDelayMs = 0;
    mdxEditorMockState.markdownValues = [];
    mdxEditorMockState.insertedMarkdownValues = [];
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
      .find((node) => node.textContent?.includes(matchText)) as HTMLButtonElement | undefined;
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
