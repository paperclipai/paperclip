// @vitest-environment jsdom

import { StrictMode, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentMentionHref,
  buildSkillMentionHref,
} from "@paperclipai/shared";
import { TaskChatComposer } from "./TaskChatComposer";
import { QuestionForm } from "./QuestionForm";
import { DRAFT_DEBOUNCE_MS } from "../../lib/composer-draft";

/**
 * MDXEditor-in-jsdom weight (mirrors MarkdownEditor.test.tsx): the real editor
 * is mocked with a contenteditable bridge — typing is simulated by setting
 * textContent and dispatching an input event, imperative setMarkdown /
 * insertMarkdown mutate the same content, and imagePlugin's config is captured
 * so the inline upload handler can be exercised directly.
 */
const mdxEditorMockState = vi.hoisted(() => ({
  imagePluginOptions: null as {
    imageUploadHandler?: (file: File) => Promise<string>;
  } | null,
}));

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");

  function setForwardedRef<T>(
    ref: React.ForwardedRef<T | null>,
    value: T | null,
  ) {
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
      contentEditableClassName,
    }: {
      markdown: string;
      onChange?: (value: string) => void;
      readOnly?: boolean;
      contentEditableClassName?: string;
    },
    forwardedRef: React.ForwardedRef<MockHandle | null>,
  ) {
    const editableRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef(markdown);
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;

    const handle = React.useMemo<MockHandle>(
      () => ({
        setMarkdown: (value: string) => {
          contentRef.current = value;
          if (editableRef.current) editableRef.current.textContent = value;
        },
        insertMarkdown: (value: string) => {
          const next = contentRef.current
            ? `${contentRef.current}${value}`
            : value;
          contentRef.current = next;
          if (editableRef.current) editableRef.current.textContent = next;
          onChangeRef.current?.(next);
        },
        focus: (callback?: () => void) => {
          editableRef.current?.focus();
          callback?.();
        },
      }),
      [],
    );

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
        data-content-class-name={contentEditableClassName}
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
    imagePlugin: (options: {
      imageUploadHandler?: (file: File) => Promise<string>;
    }) => {
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
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="task-chat-composer-send"]',
  )!;
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
      new KeyboardEvent("keydown", {
        key,
        ...modifiers,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function pasteFiles(files: File[]) {
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { files, types: ["Files"] },
  });
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
  const menu = document.body.querySelector(
    '[data-testid="mention-autocomplete-menu"]',
  );
  expect(menu).toBeTruthy();
  const option = Array.from(
    menu!.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
  ).find((node) => node.textContent?.includes(matchText));
  expect(option).toBeTruthy();
  return option!;
}

describe("TaskChatComposer", () => {
  it("adds 10px to the composer's original 8px interior padding", () => {
    render(<TaskChatComposer onAdd={async () => {}} workMode="standard" />);

    const composer = container.querySelector(
      '[data-testid="task-chat-composer-input"]',
    )?.parentElement;

    expect(composer?.className).toContain("p-(--sz-18px)");
    expect(composer?.className).not.toContain("p-2");
  });

  it("leaves an 8px token gap between the editor and action row", () => {
    render(
      <TaskChatComposer
        onAdd={async () => {}}
        workMode="planning"
        onWorkModeChange={async () => {}}
      />,
    );

    const actions = container.querySelector(
      '[data-testid="task-chat-composer-actions"]',
    );

    expect(actions?.classList).toContain("mt-2");
    expect(actions?.classList).not.toContain("mt-1");
  });

  it("renders a light card shell while preserving the borderless dark treatment", () => {
    render(
      <TaskChatComposer
        onAdd={async () => {}}
        workMode="planning"
        onWorkModeChange={async () => {}}
        enableReassign
        currentAssigneeValue="agent:runner"
        reassignOptions={[{ id: "agent:runner", label: "Runner" }]}
      />,
    );

    const composer = container.firstElementChild as HTMLElement;
    const mode = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-composer-mode"]',
    )!;
    const runner = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-composer-assignee"]',
    )!;

    expect(composer.classList).toContain("border");
    expect(composer.classList).toContain("border-border");
    expect(composer.classList).toContain("bg-card");
    expect(composer.classList).toContain("shadow-(--shadow-task-composer)");
    expect(composer.classList).toContain("dark:border-0");
    expect(composer.classList).toContain("dark:bg-muted");
    expect(composer.classList).toContain("dark:shadow-none");
    expect(composer.className).not.toContain("focus-within:ring");
    expect(mode.classList).not.toContain("border");
    expect(mode.className).not.toContain("ring-");
    expect(runner.classList).toContain("border-0");
    expect(runner.classList).not.toContain("border");
    expect(runner.className).not.toContain("ring-2");
  });

  it("scopes the wrapping placeholder override to the task-chat composer", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);

    expect(container.firstElementChild?.classList).toContain(
      "paperclip-task-chat-composer",
    );
  });

  it("reserves enough mobile editor height for a wrapped two-line placeholder", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" mobile />);

    expect(editable().dataset.contentClassName).toContain("min-h-(--sz-72px)");
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
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onWorkModeChange={onWorkModeChange}
      />,
    );

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-mode"]',
    )!;
    expect(chip.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(chip.textContent).toContain("Auto");

    pressKey("Tab", { shiftKey: true });
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    typeText("do the plan");
    pressKey("Enter", { metaKey: true });
    await flushAsync();

    expect(onWorkModeChange).toHaveBeenCalledWith("planning");
    expect(onAdd).toHaveBeenCalledWith("do the plan", undefined, undefined);
  });

  it("cycles Auto, Plan, and Ask modes with Cmd+Period while focused", () => {
    const onWorkModeChange = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onWorkModeChange={onWorkModeChange}
      />,
    );

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-mode"]',
    )!;
    editable().focus();

    expect(chip.getAttribute("aria-keyshortcuts")).toContain("Meta+Period");
    expect(chip.getAttribute("data-pending-work-mode")).toBe("standard");

    const cycleMode = () => {
      const event = new KeyboardEvent("keydown", {
        key: ".",
        code: "Period",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      flushSync(() => editable().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };

    cycleMode();
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    cycleMode();
    expect(chip.getAttribute("data-pending-work-mode")).toBe("ask");
    expect(chip.textContent).toContain("Ask");

    cycleMode();
    expect(chip.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(chip.textContent).toContain("Auto");
    expect(onWorkModeChange).not.toHaveBeenCalled();
  });

  it("uses the borderless Paper controls and inverse circular send button", () => {
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onWorkModeChange={vi.fn()}
        enableReassign
        reassignOptions={[{ id: "agent:a1", label: "Chief of Staff" }]}
        currentAssigneeValue="agent:a1"
      />,
    );

    const mode = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-mode"]')!;
    const assignee = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-assignee"]')!;
    const send = sendButton();

    expect(mode.classList).not.toContain("border");
    expect(mode.classList).toContain("border-0");
    expect(mode.classList).toContain("status-chip");
    expect(mode.style.getPropertyValue("--sc")).toBe("var(--tc-mode-agent)");
    expect(assignee.classList).toContain("border-0");
    expect(assignee.classList).toContain("shadow-none");
    expect(send.classList).toContain("rounded-full");
    expect(send.classList).toContain("bg-foreground");
    expect(send.classList).toContain("text-background");
    expect(send.classList).toContain("disabled:opacity-100");
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
    expect(
      container.querySelector('[data-testid="task-chat-composer-attach"]'),
    ).toBeNull();

    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      container.querySelector('[data-testid="task-chat-composer-attach"]'),
    ).not.toBeNull();
  });

  it("wires the editor's inline image upload to onAttachImage and returns the attachment URL", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/shot.png",
      originalFilename: "shot.png",
    });
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    const handler = mdxEditorMockState.imagePluginOptions?.imageUploadHandler;
    expect(handler).toBeTypeOf("function");

    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    await expect(handler!(file)).resolves.toBe("/attachments/shot.png");
    expect(onAttachImage).toHaveBeenCalledWith(file);
    // Inline images do not go through the attachment chip row.
    expect(
      container.querySelector('[data-testid="task-chat-composer-attachments"]'),
    ).toBeNull();
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
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    const paste = pasteFiles([file]);
    await flushAsync();

    // The all-non-image paste is swallowed before the editor sees it.
    expect(paste.defaultPrevented).toBe(true);
    expect(onAttachImage).toHaveBeenCalledWith(file);
    const chips = container.querySelector(
      '[data-testid="task-chat-composer-attachments"]',
    );
    expect(chips?.textContent).toContain("notes.txt");
    // base/attachment chip: kind · size description and a settled state.
    expect(chips?.textContent).toContain("Text · 5 B");
    expect(
      chips
        ?.querySelector('[data-slot="attachment"]')
        ?.getAttribute("data-state"),
    ).toBe("done");

    // The editor stays prose-only; the reference rides along at submit time,
    // and an attached chip alone is enough to enable send.
    expect(editable().textContent ?? "").not.toContain("notes.txt");
    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-send"]',
    )!;
    expect(send.disabled).toBe(false);
    flushSync(() => send.click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(
      "[notes.txt](/attachments/notes.txt)",
      undefined,
      undefined,
    );
    // Chips clear once the message posts.
    expect(
      container.querySelector('[data-testid="task-chat-composer-attachments"]'),
    ).toBeNull();
  });

  it("appends file references after typed prose on submit", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    typeText("Please review this.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-send"]',
    )!;
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
    let resolveUpload!: (value: {
      contentPath: string;
      originalFilename: string;
    }) => void;
    const onAttachImage = vi.fn().mockReturnValue(
      new Promise<{ contentPath: string; originalFilename: string }>(
        (resolve) => {
          resolveUpload = resolve;
        },
      ),
    );
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    typeText("Here is the file.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    // Text alone would enable send, but the in-flight upload must hold it —
    // otherwise the comment posts without the file the user selected.
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    expect(onAdd).not.toHaveBeenCalled();

    resolveUpload({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
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
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    typeText("Here is the file.");
    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    // Text alone would enable send, but the failed chip must hold it —
    // otherwise the comment posts without the file and the error chip clears.
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    expect(onAdd).not.toHaveBeenCalled();

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove notes.txt"]',
    );
    flushSync(() => remove!.click());
    expect(sendButton().disabled).toBe(false);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith(
      "Here is the file.",
      undefined,
      undefined,
    );
  });

  it("removes an attachment chip via its remove button", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove notes.txt"]',
    );
    expect(remove).not.toBeNull();
    flushSync(() => remove!.click());
    expect(
      container.querySelector('[data-testid="task-chat-composer-attachments"]'),
    ).toBeNull();
  });

  it("shows an error-state chip when a non-image upload fails", async () => {
    const onAttachImage = vi.fn().mockRejectedValue(new Error("Too large"));
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    pasteFiles([new File(["plain"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();

    const chips = container.querySelector(
      '[data-testid="task-chat-composer-attachments"]',
    );
    expect(
      chips
        ?.querySelector('[data-slot="attachment"]')
        ?.getAttribute("data-state"),
    ).toBe("error");
    expect(chips?.textContent).toContain("Too large");
  });

  it("leaves pasted images to the editor's image plugin (no chip, paste not swallowed)", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );

    const image = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const text = new File(["plain"], "notes.txt", { type: "text/plain" });
    const paste = pasteFiles([image, text]);
    await flushAsync();

    // Mixed paste: the non-image is chipped, the image flows through untouched.
    expect(paste.defaultPrevented).toBe(false);
    const chips = container.querySelector(
      '[data-testid="task-chat-composer-attachments"]',
    )!;
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
        mentions={[
          { id: "agent:a1", kind: "agent", name: "Clippy", agentId: "a1" },
        ]}
      />,
    );

    typeText("@Cl");
    await placeCaretAtEnd();

    const option = autocompleteOption("Clippy");
    flushSync(() => {
      option.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
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
      option.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await flushAsync();

    expect(editable().textContent).toBe(`[/deploy](${SLASH_HREF}) `);
  });

  it("shows the assignee combobox only when reassign is enabled, with the current label", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);
    expect(
      container.querySelector('[data-testid="task-chat-composer-assignee"]'),
    ).toBeNull();

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
    const trigger = container.querySelector(
      '[data-testid="task-chat-composer-assignee"]',
    );
    expect(trigger?.textContent).toContain("Sam");
  });

  it("shows configured agent icons in the assignee trigger and dropdown options", async () => {
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        enableReassign
        reassignOptions={[
          { id: "agent:a1", label: "Clippy" },
          { id: "agent:a2", label: "Plain Agent" },
        ]}
        agentMap={
          new Map([
            ["a1", { icon: "rocket" }],
            ["a2", { icon: null }],
          ])
        }
        currentAssigneeValue="agent:a1"
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-assignee"]',
    )!;
    expect(
      trigger.querySelector('[data-assignee-trigger-icon="rocket"]'),
    ).not.toBeNull();

    flushSync(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(
      document.querySelector('[data-assignee-option-icon="agent:a1"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-assignee-option-icon="agent:a2"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('[data-assignee-identity="agent:a2"]')
        ?.getAttribute("data-assignee-option-icon"),
    ).toBe("agent:a2");
  });

  it("shows human avatars in assignee options and after selection", async () => {
    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        enableReassign
        reassignOptions={[
          { id: "agent:a1", label: "Clippy" },
          { id: "user:u1", label: "Sam Rivera" },
        ]}
        agentMap={new Map([["a1", { icon: "rocket" }]])}
        userProfileMap={
          new Map([["u1", { label: "Sam Rivera", image: "/sam-avatar.png" }]])
        }
        currentAssigneeValue="agent:a1"
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-assignee"]',
    )!;
    flushSync(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    const userOptionAvatar = document.querySelector(
      '[data-assignee-option-avatar="user:u1"]',
    );
    expect(userOptionAvatar).not.toBeNull();
    const userOption = userOptionAvatar?.closest("button");
    flushSync(() => {
      userOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(trigger.textContent).toContain("Sam Rivera");
    expect(
      trigger.querySelector('[data-assignee-trigger-avatar="u1"]'),
    ).not.toBeNull();
  });

  describe("draft persistence", () => {
    const draftKey = "task-chat-draft:issue-1";

    it("restores a saved draft on mount", () => {
      localStorage.setItem(draftKey, "unsent draft");

      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          draftKey={draftKey}
        />,
      );

      expect(editable().textContent).toBe("unsent draft");
      expect(sendButton().disabled).toBe(false);
    });

    it("preserves a restored draft through the StrictMode effect probe", () => {
      localStorage.setItem(draftKey, "still here");

      render(
        <StrictMode>
          <TaskChatComposer
            onAdd={vi.fn()}
            workMode="standard"
            draftKey={draftKey}
          />
        </StrictMode>,
      );

      expect(editable().textContent).toBe("still here");
      expect(localStorage.getItem(draftKey)).toBe("still here");
    });

    it("saves after the debounce and flushes a pending value on unmount", () => {
      vi.useFakeTimers();
      try {
        render(
          <TaskChatComposer
            onAdd={vi.fn()}
            workMode="standard"
            draftKey={draftKey}
          />,
        );
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
        render(
          <TaskChatComposer
            onAdd={vi.fn()}
            workMode="standard"
            draftKey={draftKey}
          />,
        );
        typeText("save before reload");

        window.dispatchEvent(new Event("beforeunload"));

        expect(localStorage.getItem(draftKey)).toBe("save before reload");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the composer and saved draft while the send is pending", async () => {
      localStorage.setItem(draftKey, "queued message");
      const onAdd = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          draftKey={draftKey}
        />,
      );

      pressKey("Enter", { metaKey: true });
      await flushAsync();

      expect(onAdd).toHaveBeenCalledWith(
        "queued message",
        undefined,
        undefined,
      );
      expect(editable().textContent).toBe("");
      expect(localStorage.getItem(draftKey)).toBeNull();
    });

    it("keeps text entered while an earlier send is pending", async () => {
      let resolveSend!: () => void;
      const onAdd = vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
      );
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          draftKey={draftKey}
        />,
      );
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
      const onAdd = vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
      );
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
      expect(
        container.querySelector(
          '[data-testid="task-chat-composer-attachments"]',
        )?.textContent,
      ).toContain("next.txt");
    });

    it("restores a failed send before text entered while it was pending", async () => {
      vi.useFakeTimers();
      try {
        let rejectSend!: (error: Error) => void;
        const onAdd = vi.fn().mockReturnValue(
          new Promise<void>((_resolve, reject) => {
            rejectSend = reject;
          }),
        );
        render(
          <TaskChatComposer
            onAdd={onAdd}
            workMode="standard"
            draftKey={draftKey}
          />,
        );
        typeText("do not lose this");
        vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
        vi.useRealTimers();

        pressKey("Enter", { metaKey: true });
        await flushAsync();
        expect(editable().textContent).toBe("");
        expect(localStorage.getItem(draftKey)).toBeNull();

        typeText("next draft");
        rejectSend(new Error("network down"));
        await flushAsync();
        await flushAsync();

        expect(editable().textContent).toBe("do not lose this\n\nnext draft");
        expect(localStorage.getItem(draftKey)).toBe(
          "do not lose this\n\nnext draft",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("queued message editing", () => {
    const draftKey = "task-chat-draft:queued-edit";

    function Harness({
      onSave,
      stale = false,
    }: {
      onSave: (commentId: string, body: string) => Promise<void>;
      stale?: boolean;
    }) {
      const [queuedEdit, setQueuedEdit] = useState<{
        commentId: string;
        body: string;
        stale?: boolean;
      } | null>({
        commentId: "queued-1",
        body: "Complete queued markdown",
        stale,
      });
      return (
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          draftKey={draftKey}
          queuedEdit={queuedEdit}
          onSaveQueuedEdit={onSave}
          onCancelQueuedEdit={() => setQueuedEdit(null)}
        />
      );
    }

    it("restores the existing composer draft after cancelling an edit", async () => {
      localStorage.setItem(draftKey, "Unsent normal draft");
      render(<Harness onSave={vi.fn().mockResolvedValue(undefined)} />);
      await flushAsync();
      await vi.waitFor(() => {
        expect(editable().textContent).toBe("Complete queued markdown");
      });
      expect(localStorage.getItem(draftKey)).toBe("Unsent normal draft");

      const cancel = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Cancel",
      );
      flushSync(() => cancel?.click());
      await flushAsync();

      expect(editable().textContent).toBe("Unsent normal draft");
      expect(localStorage.getItem(draftKey)).toBe("Unsent normal draft");
    });

    it("saves through the queue callback without posting a new comment", async () => {
      localStorage.setItem(draftKey, "Normal draft stays here");
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<Harness onSave={onSave} />);
      await flushAsync();
      typeText("Edited queued markdown");

      pressKey("Enter", { metaKey: true });
      await flushAsync();
      await flushAsync();

      expect(onSave).toHaveBeenCalledWith("queued-1", "Edited queued markdown");
      expect(editable().textContent).toBe("Normal draft stays here");
    });

    it("retains edited text when the queue target rejects the save", async () => {
      const onSave = vi
        .fn()
        .mockRejectedValue(new Error("queued_comment_stale_target"));
      render(<Harness onSave={onSave} />);
      await flushAsync();
      typeText("Keep this replacement text");

      pressKey("Enter", { metaKey: true });
      await flushAsync();

      await vi.waitFor(() => {
        expect(editable().textContent).toBe("Keep this replacement text");
        expect(container.textContent).toContain("Editing queued message");
      });
    });

    it("offers a stale edit as a new queued message and preserves its Markdown source", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<Harness onSave={onSave} stale />);
      await flushAsync();

      typeText("  replacement with trailing Markdown  ");
      expect(container.textContent).toContain("Queued message changed");
      expect(sendButton().getAttribute("aria-label")).toBe(
        "Queue as new message",
      );
      pressKey("Enter", { metaKey: true });
      await flushAsync();
      await flushAsync();

      expect(onSave).toHaveBeenCalledWith(
        "queued-1",
        "  replacement with trailing Markdown  ",
      );
    });
  });

  describe("composer takeovers", () => {
    it("replaces the editor with one action surface and exposes Skip", async () => {
      const onSkip = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "question-1",
            label: "Deployment target",
            pendingCount: 2,
            content: <p>Which environment should receive this?</p>,
            onDismiss: vi.fn(),
            onSkip,
            onShowNext: vi.fn(),
          }}
        />,
      );

      expect(
        container.querySelector('[data-testid="task-chat-composer-takeover"]')
          ?.textContent,
      ).toContain("Which environment should receive this?");
      expect(container.querySelector('[data-testid="mdx-editor"]')).toBeNull();
      expect(container.textContent).not.toContain("Input needed");
      expect(container.textContent).not.toContain("Write instead");
      const skip = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Skip");
      flushSync(() => skip?.click());
      await flushAsync();
      expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it("restores the exact ordinary draft after Skip", async () => {
      const draftKey = "task-composer-takeover-draft";
      localStorage.setItem(draftKey, "Preserved draft with **markdown**");

      function Harness() {
        const [open, setOpen] = useState(true);
        return (
          <TaskChatComposer
            onAdd={vi.fn()}
            workMode="planning"
            draftKey={draftKey}
            takeover={
              open
                ? {
                    id: "plan-review",
                    label: "Review plan",
                    pendingCount: 1,
                    content: <p>Do you accept this plan?</p>,
                    onDismiss: () => setOpen(false),
                    onSkip: () => setOpen(false),
                  }
                : null
            }
          />
        );
      }

      render(<Harness />);
      const skip = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Skip");
      flushSync(() => skip?.click());
      await flushAsync();

      expect(editable().textContent).toBe("Preserved draft with **markdown**");
      expect(container.textContent).not.toContain("Write instead");
    });

    it("keeps title, pending count, pagination, and dismiss on one header row", () => {
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "paged-questions",
            label: "Release decisions",
            pendingCount: 2,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="release-decisions"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "scope",
                      prompt: "Where should this ship?",
                      required: false,
                      answerMode: "single_select",
                      options: [{ id: "pilot", label: "Pilot" }],
                    },
                    {
                      id: "checks",
                      prompt: "Which checks matter?",
                      required: false,
                      answerMode: "multi_select",
                      options: [{ id: "a11y", label: "Accessibility" }],
                    },
                  ],
                }}
                onSubmit={vi.fn()}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
            onShowNext: vi.fn(),
          }}
        />,
      );

      const header = container.querySelector(
        '[data-testid="task-chat-composer-takeover-header"]',
      );
      expect(header?.textContent).toContain("Release decisions");
      expect(header?.textContent).toContain("2 pending");
      expect(header?.textContent).toContain("1 of 2");
      expect(
        header?.querySelector('button[aria-label="Dismiss Release decisions"]'),
      ).not.toBeNull();
      expect(
        header?.querySelector('[aria-label="Question pagination"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="task-chat-composer-takeover-body"] [aria-label="Question pagination"]',
        ),
      ).toBeNull();
    });

    it("places Skip beside Submit answers for structured questions", () => {
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "structured-question",
            label: "Deployment target",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="deployment-target"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "environment",
                      prompt: "Which environment should receive this?",
                      required: true,
                      answerMode: "multi_select",
                      options: [
                        { id: "staging", label: "Staging", recommended: true },
                        { id: "production", label: "Production" },
                      ],
                    },
                  ],
                }}
                onSubmit={vi.fn()}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      );
      const skip = buttons.find(
        (button) => button.textContent?.trim() === "Skip",
      );
      const submit = buttons.find(
        (button) => button.textContent?.trim() === "Submit answers",
      );
      expect(skip).not.toBeUndefined();
      expect(submit).not.toBeUndefined();
      expect(skip?.parentElement).toBe(submit?.parentElement);
      expect(
        buttons.filter((button) => button.textContent?.trim() === "Skip"),
      ).toHaveLength(1);
      const takeoverBody = container.querySelector(
        '[data-testid="task-chat-composer-takeover-body"]',
      );
      expect(takeoverBody?.className).not.toContain("max-h-");
      expect(takeoverBody?.className).not.toContain("overflow-y-auto");
      expect(takeoverBody?.className).not.toContain("pr-8");

      const staging = buttons.find((button) =>
        button.textContent?.includes("Staging"),
      );
      const production = buttons.find(
        (button) => button.textContent?.trim() === "Production",
      );
      expect(staging?.getAttribute("data-recommended")).toBe("true");
      expect(staging?.className.split(" ")).toContain("bg-muted/50");
      expect(
        production?.className
          .split(" ")
          .some(
            (token) => token.startsWith("border") || token.startsWith("bg-"),
          ),
      ).toBe(false);

      flushSync(() => staging?.click());
      expect(staging?.getAttribute("data-selected")).toBe("true");
      expect(staging?.className.split(" ")).toContain("bg-muted/80");
    });

    it("hides Skip when the takeover already provides a request-changes path", () => {
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="planning"
          takeover={{
            id: "plan-review",
            label: "Review the proposed plan",
            pendingCount: 1,
            content: <p>Do you accept this plan?</p>,
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
            hideSkip: true,
          }}
        />,
      );

      expect(container.textContent).not.toContain("Skip");
      expect(
        container.querySelector(
          'button[aria-label="Dismiss Review the proposed plan"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="task-chat-composer-takeover"] .border-t',
        ),
      ).toBeNull();
    });

    it("dismisses every takeover without invoking Skip", async () => {
      const onDismiss = vi.fn();
      const onSkip = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "dismissable-question",
            label: "Release questions",
            pendingCount: 1,
            content: <p>Which release should ship?</p>,
            onDismiss,
            onSkip,
          }}
        />,
      );

      flushSync(() =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Dismiss Release questions"]',
          )
          ?.click(),
      );
      await flushAsync();

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onSkip).not.toHaveBeenCalled();
    });
  });
});
