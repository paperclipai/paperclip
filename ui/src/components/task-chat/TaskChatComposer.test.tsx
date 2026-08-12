// @vitest-environment jsdom

import { StrictMode, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { TaskChatComposer } from "./TaskChatComposer";
import { DRAFT_DEBOUNCE_MS } from "../../lib/composer-draft";

/**
 * MDXEditor-in-jsdom weight (mirrors MarkdownEditor.test.tsx): the real editor
 * is mocked with a contenteditable bridge — typing is simulated by setting
 * textContent and dispatching an input event, imperative setMarkdown /
 * insertMarkdown mutate the same content, and imagePlugin's config is captured
 * so the inline upload handler can be exercised directly.
 */
const mdxEditorMockState = vi.hoisted(() => ({
  imagePluginOptions: null as { imageUploadHandler?: (file: File) => Promise<string> } | null,
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

  interface MockHandle {
    setMarkdown: (value: string) => void;
    insertMarkdown: (value: string) => void;
    focus: (callback?: () => void) => void;
  }

  const MDXEditor = React.forwardRef(function MockMDXEditor(
    {
      markdown,
      onChange,
      readOnly,
    }: {
      markdown: string;
      onChange?: (value: string) => void;
      readOnly?: boolean;
    },
    forwardedRef: React.ForwardedRef<MockHandle | null>,
  ) {
    const editableRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef(markdown);
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;

    const handle = React.useMemo<MockHandle>(() => ({
      setMarkdown: (value: string) => {
        contentRef.current = value;
        if (editableRef.current) editableRef.current.textContent = value;
      },
      insertMarkdown: (value: string) => {
        const next = contentRef.current ? `${contentRef.current}${value}` : value;
        contentRef.current = next;
        if (editableRef.current) editableRef.current.textContent = next;
        onChangeRef.current?.(next);
      },
      focus: (callback?: () => void) => {
        editableRef.current?.focus();
        callback?.();
      },
    }), []);

    React.useEffect(() => {
      if (editableRef.current && contentRef.current) {
        editableRef.current.textContent = contentRef.current;
      }
      setForwardedRef(forwardedRef, handle);
      return () => setForwardedRef(forwardedRef, null);
    }, [forwardedRef, handle]);

    return (
      <div
        ref={editableRef}
        data-testid="mdx-editor"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={(e) => {
          const next = e.currentTarget.textContent ?? "";
          contentRef.current = next;
          onChangeRef.current?.(next);
        }}
      />
    );
  });

  return {
    CodeMirrorEditor: () => null,
    MDXEditor,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    createRootEditorSubscription$: Symbol("createRootEditorSubscription$"),
    headingsPlugin: () => ({}),
    imagePlugin: (options: { imageUploadHandler?: (file: File) => Promise<string> }) => {
      mdxEditorMockState.imagePluginOptions = options;
      return {};
    },
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

vi.mock("../../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

vi.mock("../../lib/paste-normalization", () => ({
  pasteNormalizationPlugin: () => ({}),
}));

const SLASH_HREF = buildSkillMentionHref("skill-1", "deploy");

vi.mock("../../context/EditorAutocompleteContext", () => ({
  useEditorAutocomplete: () => ({
    slashCommands: [
      {
        id: "skill:skill-1",
        kind: "skill",
        skillId: "skill-1",
        key: "deploy",
        name: "Deploy",
        slug: "deploy",
        description: null,
        href: SLASH_HREF,
        aliases: ["deploy", "Deploy"],
      },
    ],
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let originalRangeRect: typeof Range.prototype.getBoundingClientRect;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mdxEditorMockState.imagePluginOptions = null;
  // jsdom ranges have zero-size rects; the mention menu measures the caret.
  originalRangeRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => ({
    x: 32, y: 24, width: 12, height: 18, top: 24, right: 44, bottom: 42, left: 32,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
  Range.prototype.getBoundingClientRect = originalRangeRect;
  window.getSelection()?.removeAllRanges();
});

function render(ui: ReactElement) {
  flushSync(() => root!.render(ui));
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function editable() {
  return container.querySelector<HTMLDivElement>('[data-testid="mdx-editor"]')!;
}

function sendButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
}

/** Simulate typing: set the contenteditable's text and fire an input event. */
function typeText(value: string) {
  const el = editable();
  flushSync(() => {
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
) {
  flushSync(() => {
    editable().dispatchEvent(
      new KeyboardEvent("keydown", { key, ...modifiers, bubbles: true, cancelable: true }),
    );
  });
}

function pasteFiles(files: File[]) {
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files, types: ["Files"] } });
  flushSync(() => {
    editable().dispatchEvent(paste);
  });
  return paste;
}

/** Place the caret at the end of the editable's first text node and announce it. */
async function placeCaretAtEnd() {
  const textNode = editable().firstChild;
  expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(textNode!, textNode!.textContent!.length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  flushSync(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  // Mention detection defers via requestAnimationFrame after input events.
  await flushAsync();
  await flushAsync();
}

function autocompleteOption(matchText: string) {
  const menu = document.body.querySelector('[data-testid="mention-autocomplete-menu"]');
  expect(menu).toBeTruthy();
  const option = Array.from(menu!.querySelectorAll<HTMLButtonElement>('button[type="button"]'))
    .find((node) => node.textContent?.includes(matchText));
  expect(option).toBeTruthy();
  return option!;
}

describe("TaskChatComposer", () => {
  it("adds 10px to the composer's original 8px interior padding", () => {
    render(<TaskChatComposer onAdd={async () => {}} workMode="standard" />);

    const composer = container
      .querySelector('[data-testid="task-chat-composer-input"]')
      ?.parentElement;

    expect(composer?.className).toContain("p-(--sz-18px)");
    expect(composer?.className).not.toContain("p-2");
  });

  it("submits the trimmed body on Cmd+Enter and clears the draft", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    expect(sendButton().disabled).toBe(true);
    typeText("  hello there  ");
    expect(sendButton().disabled).toBe(false);

    pressKey("Enter", { metaKey: true });
    await flushAsync();
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("hello there", undefined, undefined);
    expect(editable().textContent).toBe("");
  });

  it("submits on Ctrl+Enter", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    typeText("hello");
    pressKey("Enter", { ctrlKey: true });
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("hello", undefined, undefined);
  });

  it("does not submit on plain Enter or Shift+Enter (newline stays with the editor)", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    typeText("line one");
    pressKey("Enter");
    pressKey("Enter", { shiftKey: true });
    await flushAsync();

    expect(onAdd).not.toHaveBeenCalled();
    expect(editable().textContent).toBe("line one");
  });

  it("cycles the pending mode with Shift+Tab and applies it on submit", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onWorkModeChange = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskChatComposer onAdd={onAdd} workMode="standard" onWorkModeChange={onWorkModeChange} />,
    );

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-mode"]')!;
    expect(chip.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(chip.textContent).toContain("Agent");

    pressKey("Tab", { shiftKey: true });
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    typeText("do the plan");
    pressKey("Enter", { metaKey: true });
    await flushAsync();

    expect(onWorkModeChange).toHaveBeenCalledWith("planning");
    expect(onAdd).toHaveBeenCalledWith("do the plan", undefined, undefined);
  });

  it("passes reopen=true when the issue resumes-to-todo and the assignee is an agent", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        issueStatus="done"
        currentAssigneeValue="agent:a1"
      />,
    );

    typeText("wake up");
    pressKey("Enter", { metaKey: true });
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("wake up", true, undefined);
  });

  it("hides the attach button without an upload handler and shows it with one", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);
    expect(container.querySelector('[data-testid="task-chat-composer-attach"]')).toBeNull();

    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(container.querySelector('[data-testid="task-chat-composer-attach"]')).not.toBeNull();
  });

  it("wires the editor's inline image upload to onAttachImage and returns the attachment URL", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/shot.png",
      originalFilename: "shot.png",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    const handler = mdxEditorMockState.imagePluginOptions?.imageUploadHandler;
    expect(handler).toBeTypeOf("function");

    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    await expect(handler!(file)).resolves.toBe("/attachments/shot.png");
    expect(onAttachImage).toHaveBeenCalledWith(file);
    // Inline images do not go through the attachment chip row.
    expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')).toBeNull();
  });

  it("does not register the image plugin without an upload handler", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);
    expect(mdxEditorMockState.imagePluginOptions).toBeNull();
  });

  it("attaches pasted non-image files to the chip row and posts a link reference", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" onAttachImage={onAttachImage} />);

    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    const paste = pasteFiles([file]);
    await flushAsync();

    // The all-non-image paste is swallowed before the editor sees it.
    expect(paste.defaultPrevented).toBe(true);
    expect(onAttachImage).toHaveBeenCalledWith(file);
    const chips = container.querySelector('[data-testid="task-chat-composer-attachments"]');
    expect(chips?.textContent).toContain("notes.txt");
    // base/attachment chip: kind · size description and a settled state.
    expect(chips?.textContent).toContain("Text · 5 B");
    expect(chips?.querySelector('[data-slot="attachment"]')?.getAttribute("data-state")).toBe("done");

    // The editor stays prose-only; the reference rides along at submit time,
    // and an attached chip alone is enough to enable send.
    expect(editable().textContent ?? "").not.toContain("notes.txt");
    const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
    expect(send.disabled).toBe(false);
    flushSync(() => send.click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(
      "[notes.txt](/attachments/notes.txt)",
      undefined,
      undefined,
    );
    // Chips clear once the message posts.
    expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')).toBeNull();
  });

  it("appends file references after typed prose on submit", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" onAttachImage={onAttachImage} />);

    typeText("Please review this.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
    flushSync(() => send.click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(
      "Please review this.\n\n[notes.txt](/attachments/notes.txt)",
      undefined,
      undefined,
    );
  });

  it("blocks send while a file upload is pending, then includes the file once it lands", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    let resolveUpload!: (value: { contentPath: string; originalFilename: string }) => void;
    const onAttachImage = vi.fn().mockReturnValue(
      new Promise<{ contentPath: string; originalFilename: string }>((resolve) => {
        resolveUpload = resolve;
      }),
    );
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" onAttachImage={onAttachImage} />);

    typeText("Here is the file.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    // Text alone would enable send, but the in-flight upload must hold it —
    // otherwise the comment posts without the file the user selected.
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    expect(onAdd).not.toHaveBeenCalled();

    resolveUpload({ contentPath: "/attachments/notes.txt", originalFilename: "notes.txt" });
    await flushAsync();
    expect(sendButton().disabled).toBe(false);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(
      "Here is the file.\n\n[notes.txt](/attachments/notes.txt)",
      undefined,
      undefined,
    );
  });

  it("blocks send while a failed attachment chip remains, then sends after it is removed", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onAttachImage = vi.fn().mockRejectedValue(new Error("Too large"));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" onAttachImage={onAttachImage} />);

    typeText("Here is the file.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    // Text alone would enable send, but the failed chip must hold it —
    // otherwise the comment posts without the file and the error chip clears.
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    expect(onAdd).not.toHaveBeenCalled();

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]');
    flushSync(() => remove!.click());
    expect(sendButton().disabled).toBe(false);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith("Here is the file.", undefined, undefined);
  });

  it("removes an attachment chip via its remove button", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]');
    expect(remove).not.toBeNull();
    flushSync(() => remove!.click());
    expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')).toBeNull();
  });

  it("shows an error-state chip when a non-image upload fails", async () => {
    const onAttachImage = vi.fn().mockRejectedValue(new Error("Too large"));
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const chips = container.querySelector('[data-testid="task-chat-composer-attachments"]');
    expect(chips?.querySelector('[data-slot="attachment"]')?.getAttribute("data-state")).toBe("error");
    expect(chips?.textContent).toContain("Too large");
  });

  it("leaves pasted images to the editor's image plugin (no chip, paste not swallowed)", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    const image = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const text = new File(["plain"], "notes.txt", { type: "text/plain" });
    const paste = pasteFiles([image, text]);
    await flushAsync();

    // Mixed paste: the non-image is chipped, the image flows through untouched.
    expect(paste.defaultPrevented).toBe(false);
    const chips = container.querySelector('[data-testid="task-chat-composer-attachments"]')!;
    expect(chips.textContent).toContain("notes.txt");
    expect(chips.textContent).not.toContain("shot.png");
    expect(onAttachImage).toHaveBeenCalledTimes(1);
    expect(onAttachImage).toHaveBeenCalledWith(text);
  });

  it("inserts an @-mention from the autocomplete menu and posts it", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        mentions={[{ id: "agent:a1", kind: "agent", name: "Clippy", agentId: "a1" }]}
      />,
    );

    typeText("@Cl");
    await placeCaretAtEnd();

    const option = autocompleteOption("Clippy");
    flushSync(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    const expected = `[@Clippy](${buildAgentMentionHref("a1", null)}) `;
    expect(editable().textContent).toBe(expected);

    pressKey("Enter", { metaKey: true });
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(expected.trim(), undefined, undefined);
  });

  it("inserts a /-command from the autocomplete menu", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    typeText("/dep");
    await placeCaretAtEnd();

    const option = autocompleteOption("/deploy");
    flushSync(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    expect(editable().textContent).toBe(`[/deploy](${SLASH_HREF}) `);
  });

  it("shows the assignee combobox only when reassign is enabled, with the current label", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);
    expect(container.querySelector('[data-testid="task-chat-composer-assignee"]')).toBeNull();

    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        enableReassign
        reassignOptions={[
          { id: "agent:a1", label: "Clippy" },
          { id: "user:u1", label: "Sam" },
        ]}
        currentAssigneeValue="user:u1"
      />,
    );
    const trigger = container.querySelector('[data-testid="task-chat-composer-assignee"]');
    expect(trigger?.textContent).toContain("Sam");
  });

  describe("draft persistence", () => {
    const draftKey = "task-chat-draft:issue-1";

    it("restores a saved draft on mount", () => {
      localStorage.setItem(draftKey, "unsent draft");

      render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" draftKey={draftKey} />);

      expect(editable().textContent).toBe("unsent draft");
      expect(sendButton().disabled).toBe(false);
    });

    it("preserves a restored draft through the StrictMode effect probe", () => {
      localStorage.setItem(draftKey, "still here");

      render(
        <StrictMode>
          <TaskChatComposer onAdd={vi.fn()} workMode="standard" draftKey={draftKey} />
        </StrictMode>,
      );

      expect(editable().textContent).toBe("still here");
      expect(localStorage.getItem(draftKey)).toBe("still here");
    });

    it("saves after the debounce and flushes a pending value on unmount", () => {
      vi.useFakeTimers();
      try {
        render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" draftKey={draftKey} />);
        typeText("work in progress");
        expect(localStorage.getItem(draftKey)).toBeNull();

        vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
        expect(localStorage.getItem(draftKey)).toBe("work in progress");

        typeText("save before leaving");
        flushSync(() => root?.unmount());
        root = null;
        expect(localStorage.getItem(draftKey)).toBe("save before leaving");
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes a pending value before page unload", () => {
      vi.useFakeTimers();
      try {
        render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" draftKey={draftKey} />);
        typeText("save before reload");

        window.dispatchEvent(new Event("beforeunload"));

        expect(localStorage.getItem(draftKey)).toBe("save before reload");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the saved draft only after a successful send", async () => {
      localStorage.setItem(draftKey, "queued message");
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={draftKey} />);

      pressKey("Enter", { metaKey: true });
      await flushAsync();

      expect(onAdd).toHaveBeenCalledWith("queued message", undefined, undefined);
      expect(localStorage.getItem(draftKey)).toBeNull();
    });

    it("keeps text entered while an earlier send is pending", async () => {
      let resolveSend!: () => void;
      const onAdd = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
        resolveSend = resolve;
      }));
      render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={draftKey} />);
      typeText("first message");

      pressKey("Enter", { metaKey: true });
      await flushAsync();
      typeText("next message");
      resolveSend();
      await flushAsync();
      await flushAsync();

      expect(onAdd).toHaveBeenCalledWith("first message", undefined, undefined);
      expect(editable().textContent).toBe("next message");
      expect(localStorage.getItem(draftKey)).toBe("next message");
    });

    it("keeps an attachment added while an earlier send is pending", async () => {
      let resolveSend!: () => void;
      const onAdd = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
        resolveSend = resolve;
      }));
      const onAttachImage = vi.fn().mockResolvedValue({
        contentPath: "/attachments/next.txt",
        originalFilename: "next.txt",
      });
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          draftKey={draftKey}
          onAttachImage={onAttachImage}
        />,
      );
      typeText("first message");

      pressKey("Enter", { metaKey: true });
      await flushAsync();
      pasteFiles([new File(["next"], "next.txt", { type: "text/plain" })]);
      await flushAsync();
      resolveSend();
      await flushAsync();
      await flushAsync();

      expect(onAdd).toHaveBeenCalledWith("first message", undefined, undefined);
      expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')?.textContent)
        .toContain("next.txt");
    });

    it("keeps the body and saved draft when sending fails", async () => {
      vi.useFakeTimers();
      try {
        const onAdd = vi.fn().mockRejectedValue(new Error("network down"));
        render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={draftKey} />);
        typeText("do not lose this");
        vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
        vi.useRealTimers();

        pressKey("Enter", { metaKey: true });
        await flushAsync();

        expect(editable().textContent).toBe("do not lose this");
        expect(localStorage.getItem(draftKey)).toBe("do not lose this");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
