// @vitest-environment jsdom

import { act, StrictMode, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentMentionHref,
  buildSkillMentionHref,
} from "@paperclipai/shared";
import { parseRunnerGoalCommand, TaskChatComposer } from "./TaskChatComposer";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { QuestionForm } from "./QuestionForm";
import { DRAFT_DEBOUNCE_MS } from "../../lib/composer-draft";
import {
  loadDraftSubmission,
  saveDraft,
  saveDraftSubmission,
} from "../../lib/composer-draft";
import { CommentSubmissionUnknownError } from "../../lib/comment-submit-result";

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

function openComposerAddMenu() {
  const add = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-add"]')!;
  flushSync(() => add.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
  return add;
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
  it("keeps creation images inline and prevents submission during their upload", async () => {
    let resolveUpload!: (url: string) => void;
    const onImageUpload = vi.fn().mockReturnValue(new Promise<string>((resolve) => { resolveUpload = resolve; }));
    const creation = {
      value: "Before the screenshot",
      onChange: vi.fn(),
      onSubmit: vi.fn().mockResolvedValue(undefined),
      submitLabel: "Create task",
      onSelectFiles: vi.fn(),
      runSettings: null,
      onRunSettingsChange: vi.fn(),
    };
    render(<TaskChatComposer creation={creation} workMode="standard" onImageUpload={onImageUpload} />);
    const image = new File(["png"], "screen.png", { type: "image/png" });
    expect(pasteFiles([image]).defaultPrevented).toBe(false);
    expect(creation.onSelectFiles).not.toHaveBeenCalled();
    const handler = mdxEditorMockState.imagePluginOptions!.imageUploadHandler!;
    const upload = handler(image);
    await flushAsync();
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    expect(creation.onSubmit).not.toHaveBeenCalled();
    resolveUpload("/api/assets/screen/content");
    const url = await upload;
    const value = `Before the screenshot\n\n![screen](${url})\n\nAfter the screenshot`;
    render(<TaskChatComposer creation={{ ...creation, value }} workMode="standard" onImageUpload={onImageUpload} />);
    await flushAsync();
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(creation.onSubmit).toHaveBeenCalledWith(value, "standard", null);
    expect(onImageUpload).toHaveBeenCalledWith(image);
  });

  it("stages non-image creation paste files while images reach the editor", () => {
    const creation = {
      value: "Inspect these files",
      onChange: vi.fn(), onSubmit: vi.fn().mockResolvedValue(undefined),
      submitLabel: "Create task", onSelectFiles: vi.fn(),
      runSettings: null, onRunSettingsChange: vi.fn(),
    };
    render(<TaskChatComposer creation={creation} workMode="standard" onImageUpload={vi.fn()} />);
    const image = new File(["png"], "screen.png", { type: "image/png" });
    const document = new File(["notes"], "notes.txt", { type: "text/plain" });
    expect(pasteFiles([image, document]).defaultPrevented).toBe(false);
    expect(creation.onSelectFiles).toHaveBeenCalledWith([document]);
    expect(pasteFiles([document]).defaultPrevented).toBe(true);
  });

  it("settles an acknowledged submission after navigating away", async () => {
    const key = "navigate-before-save";
    let resolveSend!: () => void;
    const onAdd = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveSend = resolve; }));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />);
    typeText("Please write a motto");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    const intent = loadDraftSubmission(key)!;
    expect(onAdd.mock.calls[0]?.[4]).toBe(intent.attemptId);
    render(<div>Another task</div>);
    resolveSend();
    await flushAsync();
    expect(loadDraftSubmission(key)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />);
    expect(container.textContent).not.toContain("Sending when reconnected…");
    expect(editable().textContent).toBe("");
  });

  it("automatically reconciles a restored submission by its server receipt, not its text", async () => {
    const key = "saved-receipt";
    const attemptId = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
    saveDraft(key, "Already answered");
    saveDraftSubmission(key, { attemptId, reviewed: false });
    const onAdd = vi.fn();
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key}
      confirmedSubmissionIds={new Set(["another-request"])} />);
    expect(loadDraftSubmission(key)).not.toBeNull();
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key}
      confirmedSubmissionIds={new Set([attemptId])} />);
    await flushAsync();
    expect(loadDraftSubmission(key)).toBeNull();
    expect(editable().textContent).toBe("");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("preserves the next draft when an uncertain submission is later confirmed after reload", async () => {
    const key = "uncertain-with-next-draft";
    let rejectSend!: (error: Error) => void;
    const onAdd = vi.fn().mockReturnValue(new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />);
    typeText("First request");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    const attemptId = loadDraftSubmission(key)!.attemptId;
    typeText("Keep this next draft");
    rejectSend(new CommentSubmissionUnknownError());
    await flushAsync();
    render(<div>Another task</div>);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key}
      confirmedSubmissionIds={new Set([attemptId])} />);
    await flushAsync();
    expect(editable().textContent).toBe("Keep this next draft");
    expect(localStorage.getItem(key)).toBe("Keep this next draft");
    expect(loadDraftSubmission(key)).toBeNull();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it.each(["acknowledgment", "receipt after reload"])("preserves a next draft across navigation before %s", async (confirmation) => {
    const key = "navigate-with-next-draft";
    let resolveSend!: () => void;
    const onAdd = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveSend = resolve; }));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />);
    typeText("First request");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    const attemptId = loadDraftSubmission(key)!.attemptId;
    typeText("Keep the unsent next request");
    render(<div>Another task</div>);
    if (confirmation === "acknowledgment") {
      resolveSend();
      await flushAsync();
    }
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key}
      confirmedSubmissionIds={new Set([attemptId])} />);
    await flushAsync();
    expect(editable().textContent).toBe("Keep the unsent next request");
    expect(localStorage.getItem(key)).toBe("Keep the unsent next request");
    expect(loadDraftSubmission(key)).toBeNull();
    expect(onAdd).toHaveBeenCalledTimes(1);
    resolveSend();
    await flushAsync();
    expect(localStorage.getItem(key)).toBe("Keep the unsent next request");
  });

  it("does not copy another task's draft into a late acknowledged submission", async () => {
    let resolveSend!: () => void;
    const onAdd = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveSend = resolve; }));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey="first-task" />);
    typeText("First request");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey="second-task" />);
    typeText("Second task draft");
    resolveSend();
    await flushAsync();
    expect(loadDraftSubmission("first-task")).toBeNull();
    expect(localStorage.getItem("first-task")).toBeNull();
    expect(editable().textContent).toBe("Second task draft");
  });

  it.each(["success", "unknown"])(
    "does not overwrite another retained attempt after an older %s",
    async (outcome) => {
      const key = "exact-attempt-settlement";
      let settle!: () => void;
      const onAdd = vi.fn().mockReturnValue(
        new Promise<void>((resolve, reject) => {
          settle =
            outcome === "success"
              ? resolve
              : () => reject(new CommentSubmissionUnknownError());
        }),
      );
      render(
        <TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />,
      );
      typeText("Older request");
      pressKey("Enter", { metaKey: true });
      await flushAsync();
      const newer = {
        version: 1,
        draftKey: key,
        attemptId: "aaf8228f-0be7-45ae-a104-6fbe0af6f1d3",
        reviewed: false,
      };
      localStorage.setItem(key, "Newer retained draft");
      localStorage.setItem(`${key}:attachments:v1`, "newer receipt sentinel");
      localStorage.setItem(`${key}:submission:v1`, JSON.stringify(newer));
      settle();
      await flushAsync();
      await flushAsync();
      window.dispatchEvent(new Event("beforeunload"));
      expect(localStorage.getItem(`${key}:submission:v1`)).toBe(
        JSON.stringify(newer),
      );
      expect(localStorage.getItem(key)).toBe("Newer retained draft");
      expect(localStorage.getItem(`${key}:attachments:v1`)).toBe(
        "newer receipt sentinel",
      );
    },
  );

  it("keeps an unconfirmed send in memory with disabled storage and resends it with the same request ID", async () => {
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage disabled");
      });
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(new CommentSubmissionUnknownError())
      .mockResolvedValue(undefined);
    try {
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          draftKey="storage-disabled"
        />,
      );
      typeText("Send this exactly once");
      pressKey("Enter", { metaKey: true });
      await flushAsync();
      await flushAsync();
      expect(sendButton().disabled).toBe(true);
      expect(container.textContent).toContain("Sending when reconnected…");
      expect(container.textContent).not.toContain("Discard draft");
      pressKey("Enter", { metaKey: true });
      await flushAsync();
      expect(onAdd).toHaveBeenCalledTimes(1);
      const resend = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Resend now",
      )!;
      flushSync(() => resend.click());
      await flushAsync();
      await flushAsync();
      expect(onAdd).toHaveBeenCalledTimes(2);
      // Same body and same client request ID, so the server dedupes.
      expect(onAdd.mock.calls[1]?.[0]).toBe(onAdd.mock.calls[0]?.[0]);
      expect(onAdd.mock.calls[1]?.[4]).toBe(onAdd.mock.calls[0]?.[4]);
      expect(container.textContent).not.toContain("Sending when reconnected…");
      expect(editable().textContent).toBe("");
    } finally {
      storage.mockRestore();
    }
  });

  it("gives an unconfirmed send back to the editor on Cancel without resending it", async () => {
    const onAdd = vi.fn().mockRejectedValue(new CommentSubmissionUnknownError());
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey="cancel-pending" />);
    typeText("Keep my words");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    await flushAsync();
    expect(loadDraftSubmission("cancel-pending")?.request?.body).toBe("Keep my words");
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    )!;
    flushSync(() => cancel.click());
    await flushAsync();
    expect(container.textContent).not.toContain("Sending when reconnected…");
    expect(editable().textContent).toBe("Keep my words");
    expect(loadDraftSubmission("cancel-pending")).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("puts the text back with readable copy when a resend is rejected", async () => {
    const { ApiError } = await import("../../api/client");
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(new CommentSubmissionUnknownError())
      .mockRejectedValueOnce(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey="rejected-resend" />);
    typeText("Rejected later");
    pressKey("Enter", { metaKey: true });
    await flushAsync();
    await flushAsync();
    const resend = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Resend now",
    )!;
    flushSync(() => resend.click());
    await flushAsync();
    await flushAsync();
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Sending when reconnected…");
    expect(editable().textContent).toBe("Rejected later");
    expect(container.textContent).toContain("Forbidden");
    expect(loadDraftSubmission("rejected-resend")).toBeNull();
  });

  it("restores an in-flight submission as uncertain only for its exact task key", async () => {
    const key = "uncertain-task-one";
    const attemptId = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
    saveDraft(key, "Retained unknown draft");
    saveDraftSubmission(key, { attemptId, reviewed: false });
    const onAdd = vi.fn();
    render(
      <StrictMode>
        <TaskChatComposer onAdd={onAdd} workMode="standard" draftKey={key} />
      </StrictMode>,
    );
    expect(editable().textContent).toBe("Retained unknown draft");
    expect(sendButton().disabled).toBe(true);
    expect(loadDraftSubmission(key)?.attemptId).toBe(attemptId);
    render(
      <StrictMode>
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          draftKey="uncertain-task-two"
        />
      </StrictMode>,
    );
    await flushAsync();
    typeText("Separate task draft");
    await flushAsync();
    expect(sendButton().disabled).toBe(false);
    expect(loadDraftSubmission(key)?.attemptId).toBe(attemptId);
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("retains explicit upload receipt IDs across a failed send without uploading again", async () => {
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again"))
      .mockResolvedValue(undefined);
    const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
    const onAttachImage = vi.fn().mockResolvedValue({
      id,
      contentPath: `/api/attachments/${id}/content`,
      originalFilename: "notes.txt",
    });
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );
    typeText("Inspect the new file.");
    pasteFiles([new File(["new bytes"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toEqual([id]);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[1]?.[3]).toEqual([id]);
    expect(onAttachImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed upload and retries it only when asked", async () => {
    const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
    const { ApiError } = await import("../../api/client");
    const onAttachImage = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Unavailable", 503, { error: "tenant_app_unavailable" }))
      .mockResolvedValue({ id, contentPath: `/api/attachments/${id}/content`, originalFilename: "notes.txt" });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);
    pasteFiles([new File(["bytes"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();
    expect(container.textContent).toContain("Paperclip is restarting or updating");
    expect(container.textContent).not.toContain("tenant_app_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAttachImage).toHaveBeenCalledTimes(1);
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Retry notes.txt"]')!;
    flushSync(() => retry.click());
    await flushAsync();
    expect(onAttachImage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button[aria-label="Retry notes.txt"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting or updating");
    expect(sendButton().disabled).toBe(false);
  });

  it("holds submission while an inline image upload is pending and binds its receipt", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const id = "5e5f9946-c706-4785-8988-d4d6f0f499ab";
    let resolveUpload!: (value: unknown) => void;
    const onAttachImage = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );
    typeText("Inspect the picture.");
    const handler = mdxEditorMockState.imagePluginOptions!.imageUploadHandler!;
    const upload = handler(
      new File(["png"], "image.png", { type: "image/png" }),
    );
    await flushAsync();
    expect(sendButton().disabled).toBe(true);
    pressKey("Enter", { metaKey: true });
    expect(onAdd).not.toHaveBeenCalled();
    resolveUpload({
      id,
      contentPath: `/api/attachments/${id}/content`,
      originalFilename: "image.png",
    });
    const url = await upload;
    typeText(`Inspect the picture.\n\n![image](${url})`);
    await flushAsync();
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toEqual([id]);
  });

  it("does not infer binding from arbitrary pasted attachment Markdown", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);
    typeText(
      "[old file](/api/attachments/9af8228f-0be7-45ae-a104-6fbe0af6f1d3/content)",
    );
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("submits multiple retained file and image receipts but not removed selections", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const receipts = [
      "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      "5e5f9946-c706-4785-8988-d4d6f0f499ab",
      "975687b9-d594-46a1-8b9e-707de6480fd7",
      "0aab5c84-8722-40f6-ae89-4b35040cedcf",
    ];
    const onAttachImage = vi.fn().mockImplementation(async (file: File) => {
      const id = receipts[onAttachImage.mock.calls.length - 1]!;
      return {
        id,
        contentPath: `/api/attachments/${id}/content`,
        originalFilename: file.name,
      };
    });
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
      />,
    );
    pasteFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]);
    await flushAsync();
    const handler = mdxEditorMockState.imagePluginOptions!.imageUploadHandler!;
    const retainedImage = await handler(
      new File(["png"], "three.png", { type: "image/png" }),
    );
    await handler(new File(["png"], "removed.png", { type: "image/png" }));
    typeText(`Only this picture remains ![three](${retainedImage})`);
    await flushAsync();
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove two.txt"]',
        )!
        .click(),
    );
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toEqual([receipts[0], receipts[2]]);
    expect(onAdd.mock.calls[0]?.[0]).not.toContain("two.txt");
    expect(onAdd.mock.calls[0]?.[0]).not.toContain("removed.png");
  });

  it("restores file and inline image receipts after a fresh composer mount", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const ids = [
      "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      "5e5f9946-c706-4785-8988-d4d6f0f499ab",
    ];
    const onAttachImage = vi.fn().mockImplementation(async (file: File) => {
      const id = ids[onAttachImage.mock.calls.length - 1]!;
      return {
        id,
        contentPath: `/api/attachments/${id}/content`,
        originalFilename: file.name,
      };
    });
    const props = {
      onAdd,
      workMode: "standard" as const,
      onAttachImage,
      draftKey: "receipt-reload",
    };
    render(<TaskChatComposer {...props} />);
    pasteFiles([new File(["text"], "file.txt", { type: "text/plain" })]);
    await flushAsync();
    const url = await mdxEditorMockState.imagePluginOptions!
      .imageUploadHandler!(
      new File(["png"], "image.png", { type: "image/png" }),
    );
    typeText(`Inspect both files ![image](${url})`);
    await flushAsync();
    render(<div />);
    render(<TaskChatComposer {...props} />);
    await flushAsync();
    expect(container.textContent).toContain("file.txt");
    expect(editable().textContent).toContain(url);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toEqual(ids);
    expect(onAttachImage).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("receipt-reload:attachments:v1")).toBeNull();
  });

  it("removes a pending inline image without a late insertion or restored receipt", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    let resolveUpload!: (value: unknown) => void;
    const onAttachImage = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    render(
      <TaskChatComposer
        onAdd={onAdd}
        workMode="standard"
        onAttachImage={onAttachImage}
        draftKey="removed-pending"
      />,
    );
    typeText("Keep this text");
    const upload = mdxEditorMockState.imagePluginOptions!.imageUploadHandler!(
      new File(["png"], "pending.png", { type: "image/png" }),
    );
    const rejected = expect(upload).rejects.toThrow("Attachment was removed");
    await flushAsync();
    expect(container.textContent).toContain("pending.png");
    expect(sendButton().disabled).toBe(true);
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove pending.png"]',
        )!
        .click(),
    );
    resolveUpload({
      id: "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      contentPath:
        "/api/attachments/9af8228f-0be7-45ae-a104-6fbe0af6f1d3/content",
    });
    await rejected;
    await flushAsync();
    expect(editable().textContent).toBe("Keep this text");
    expect(localStorage.getItem("removed-pending:attachments:v1")).toBeNull();
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd.mock.calls[0]?.[3]).toBeUndefined();
  });
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

    const composer = container.querySelector<HTMLElement>(".paperclip-task-chat-composer")!;
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
    expect(mode.classList).toContain("rounded-full");
    expect(mode.getAttribute("aria-label")).toBe("Remove Plan mode");
    expect(runner.classList).toContain("border-0");
    expect(runner.classList).not.toContain("border");
    expect(runner.className).not.toContain("ring-2");
  });

  it("scopes the wrapping placeholder override to the task-chat composer", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);

    expect(container.querySelector("[data-testid='task-chat-composer-input']")?.parentElement?.classList).toContain(
      "paperclip-task-chat-composer",
    );
  });

  it("uses a compact mobile editor that can grow with the message", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" mobile />);

    expect(editable().dataset.contentClassName).toContain("min-h-(--sz-48px)");
    expect(editable().dataset.contentClassName).toContain("max-h-(--sz-28dvh)");
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

    expect(onAdd).toHaveBeenCalledWith("hello there", undefined, undefined, undefined, expect.any(String));
    expect(editable().textContent).toBe("");
  });

  it("submits on Ctrl+Enter", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    typeText("hello");
    pressKey("Enter", { ctrlKey: true });
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("hello", undefined, undefined, undefined, expect.any(String));
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

    expect(container.querySelector('[data-testid="task-chat-composer-add"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')).toBeNull();

    pressKey("Tab", { shiftKey: true });
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-mode"]',
    )!;
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    typeText("do the plan");
    pressKey("Enter", { metaKey: true });
    await flushAsync();

    expect(onWorkModeChange).toHaveBeenCalledWith("planning");
    expect(onAdd).toHaveBeenCalledWith("do the plan", undefined, undefined, undefined, expect.any(String));
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

    editable().focus();

    expect(container.querySelector('[data-testid="task-chat-composer-add"]')?.getAttribute("aria-keyshortcuts")).toContain("Meta+Period");
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')).toBeNull();

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
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-mode"]')!;
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    cycleMode();
    expect(chip.getAttribute("data-pending-work-mode")).toBe("ask");
    expect(chip.textContent).toContain("Ask");

    cycleMode();
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')).toBeNull();
    expect(onWorkModeChange).not.toHaveBeenCalled();
  });

  it("selects exclusive modes from the add menu and removes the active chip", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onWorkModeChange={vi.fn()} />);
    openComposerAddMenu();
    expect(document.querySelector('[data-testid="composer-add-file"]')).toBeNull();
    flushSync(() => (document.querySelector('[data-testid="composer-add-plan"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')?.textContent).toContain("Plan mode");

    openComposerAddMenu();
    flushSync(() => (document.querySelector('[data-testid="composer-add-ask"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')?.textContent).toContain("Ask mode");

    flushSync(() => (container.querySelector('[data-testid="task-chat-composer-mode"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')).toBeNull();
  });

  it("opens a mobile Add dialog while keeping Send at the end of the footer", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onWorkModeChange={vi.fn()}
      onAttachImage={vi.fn().mockResolvedValue(undefined)} mobile enableReassign
      reassignOptions={[{ id: "agent:codex", label: "Codie" }]}
      currentAssigneeValue="agent:codex" />);

    const actions = container.querySelector<HTMLElement>('[data-testid="task-chat-composer-actions"]')!;
    expect(actions.lastElementChild?.lastElementChild).toBe(sendButton());
    expect(actions.firstElementChild?.contains(sendButton())).toBe(false);
    expect(actions.lastElementChild?.querySelector('[data-testid="task-chat-composer-assignee"]')).not.toBeNull();
    expect(actions.querySelector('[data-testid="task-chat-composer-assignee"] [data-slot="agent-avatar"] img')).not.toBeNull();

    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-add"]')!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("Files and images");
    expect(dialog?.textContent).toContain("Plan mode");
    expect(dialog?.textContent).toContain("Ask mode");

    flushSync(() => document.querySelector<HTMLButtonElement>('[data-testid="composer-add-plan"]')!.click());
    const mode = container.querySelector<HTMLElement>('[data-testid="task-chat-composer-mode"]')!;
    expect(mode.textContent).toContain("Plan mode");
    expect(actions.contains(mode)).toBe(true);
    expect(mode.querySelector(".sr-only")?.textContent).toBe("Plan mode");
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  });

  it("opens the mobile file picker from the Add dialog", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" mobile
      onAttachImage={vi.fn().mockResolvedValue(undefined)} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-add"]')!.click());
    flushSync(() => document.querySelector<HTMLButtonElement>('[data-testid="composer-add-file"]')!.click());
    expect(openPicker).toHaveBeenCalledOnce();
  });

  it("uses the Add dialog through the mobile shell's tablet breakpoint", () => {
    const matchMedia = vi.fn((query: string) => ({
      media: query,
      matches: query === "(max-width: 767px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      render(<ComposerAddMenu mode="standard" onModeChange={vi.fn()} />);
      flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Add to composer"]')!.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
    } finally {
      vi.unstubAllGlobals();
    }
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

    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-add"]',
    )!;
    const assignee = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-assignee"]',
    )!;
    const send = sendButton();

    expect(add.classList).not.toContain("border");
    expect(add.getAttribute("aria-label")).toBe("Add to composer");
    expect(container.querySelector('[data-testid="task-chat-composer-mode"]')).toBeNull();
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

    expect(onAdd).toHaveBeenCalledWith("wake up", true, undefined, undefined, expect.any(String));
  });

  it("shows the add menu only when at least one action is available", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" />);
    expect(
      container.querySelector('[data-testid="task-chat-composer-add"]'),
    ).toBeNull();

    render(
      <TaskChatComposer
        onAdd={vi.fn()}
        workMode="standard"
        onAttachImage={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      container.querySelector('[data-testid="task-chat-composer-add"]'),
    ).not.toBeNull();
  });

  it("opens the file picker from the add menu", () => {
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard"
      onAttachImage={vi.fn().mockResolvedValue(undefined)} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
    openComposerAddMenu();
    flushSync(() => document.querySelector<HTMLElement>('[data-testid="composer-add-file"]')!.click());
    expect(openPicker).toHaveBeenCalledOnce();
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
    expect(onAdd).toHaveBeenCalledWith("[notes.txt](/attachments/notes.txt)", undefined, undefined, undefined, expect.any(String));
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
    expect(onAdd).toHaveBeenCalledWith("Please review this.\n\n[notes.txt](/attachments/notes.txt)", undefined, undefined, undefined, expect.any(String));
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
    expect(onAdd).toHaveBeenCalledWith("Here is the file.\n\n[notes.txt](/attachments/notes.txt)", undefined, undefined, undefined, expect.any(String));
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
    expect(onAdd).toHaveBeenCalledWith("Here is the file.", undefined, undefined, undefined, expect.any(String));
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
    expect(onAdd).toHaveBeenCalledWith(expected.trim(), undefined, undefined, undefined, expect.any(String));
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

  describe("/goal action commands", () => {
    const capability = {
      availability: "available" as const,
      verified: true,
      actions: ["set", "pause", "resume", "clear"] as Array<
        "set" | "pause" | "resume" | "clear"
      >,
      autonomousUpdates: true,
      persistentAcrossResume: true,
      maxObjectiveChars: 4_000,
      tokenBudgetControl: true,
      usageReporting: true,
    };

    it("matches only an exact first /goal token", () => {
      expect(parseRunnerGoalCommand(" /goal Ship the feature ")).toEqual({
        matched: true,
        command: { action: "create", objective: "Ship the feature" },
      });
      expect(
        parseRunnerGoalCommand(
          "[/goal\u00a0](</goal Ship the feature across turns.>)",
        ),
      ).toEqual({
        matched: true,
        command: {
          action: "create",
          objective: "Ship the feature across turns.",
        },
      });
      expect(
        parseRunnerGoalCommand(
          "[/go](</goal Return one concise confirmation, then complete.>)",
        ),
      ).toEqual({
        matched: true,
        command: {
          action: "create",
          objective: "Return one concise confirmation, then complete.",
        },
      });
      expect(
        parseRunnerGoalCommand("[/](/goal%20Confirm%20the%20goal%20state.)"),
      ).toEqual({
        matched: true,
        command: {
          action: "create",
          objective: "Confirm the goal state.",
        },
      });
      expect(parseRunnerGoalCommand("[/goal](/goal%20pause)")).toEqual({
        matched: true,
        command: { action: "pause" },
      });
      expect(parseRunnerGoalCommand("/goal pause extra")).toEqual({
        matched: true,
        error: "/goal pause does not accept extra arguments.",
      });
      expect(parseRunnerGoalCommand("[goal](/goal Ship it)")).toEqual({
        matched: false,
      });
      expect(parseRunnerGoalCommand("\\/goal ordinary text")).toEqual({
        matched: false,
      });
      expect(parseRunnerGoalCommand("/goalkeeper ordinary text")).toEqual({
        matched: false,
      });
    });

    it("dispatches a goal action without posting a comment", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      const onRunnerGoalCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          runnerGoalCapability={capability}
          onRunnerGoalCommand={onRunnerGoalCommand}
        />,
      );

      typeText("/goal Ship the feature");
      pressKey("Enter", { metaKey: true });
      await flushAsync();

      expect(onRunnerGoalCommand).toHaveBeenCalledWith({
        action: "create",
        objective: "Ship the feature",
      });
      expect(onAdd).not.toHaveBeenCalled();
      expect(editable().textContent).toBe("");
    });

    it("shows Goal in the add menu only for a supported agent and prepares the command", async () => {
      const onRunnerGoalCommand = vi.fn();
      render(<TaskChatComposer onAdd={vi.fn()} workMode="standard"
        onWorkModeChange={vi.fn()} runnerGoalCapability={capability} onRunnerGoalCommand={onRunnerGoalCommand} />);
      typeText("Ship the feature");
      openComposerAddMenu();
      const goal = document.querySelector<HTMLElement>('[data-testid="composer-add-goal"]');
      expect(goal).not.toBeNull();
      flushSync(() => goal!.click());
      await flushAsync();
      expect(editable().textContent).toBe("/goal Ship the feature");
      expect(onRunnerGoalCommand).not.toHaveBeenCalled();

      render(<TaskChatComposer onAdd={vi.fn()} workMode="standard"
        onWorkModeChange={vi.fn()}
        runnerGoalCapability={{ ...capability, availability: "unsupported" }}
        onRunnerGoalCommand={onRunnerGoalCommand} />);
      openComposerAddMenu();
      expect(document.querySelector('[data-testid="composer-add-goal"]')).toBeNull();
    });

    it("commits a pending agent reassignment before starting the goal", async () => {
      const order: string[] = [];
      const onAdd = vi.fn().mockResolvedValue(undefined);
      const onPendingAssigneeChange = vi.fn();
      const onRunnerGoalReassign = vi.fn().mockImplementation(async () => {
        order.push("reassign");
      });
      const onRunnerGoalCommand = vi.fn().mockImplementation(async () => {
        order.push("goal");
      });
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          enableReassign
          reassignOptions={[{ id: "agent:a1", label: "Clippy" }]}
          currentAssigneeValue=""
          onPendingAssigneeChange={onPendingAssigneeChange}
          runnerGoalCapability={capability}
          onRunnerGoalReassign={onRunnerGoalReassign}
          onRunnerGoalCommand={onRunnerGoalCommand}
        />,
      );

      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-composer-assignee"]',
      )!;
      flushSync(() => trigger.click());
      await flushAsync();
      const option = [
        ...document.body.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Clippy");
      expect(option).toBeDefined();
      flushSync(() => option!.click());
      await flushAsync();

      openComposerAddMenu();
      expect(document.querySelector('[data-testid="composer-add-goal"]')).not.toBeNull();
      flushSync(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

      typeText("/goal Ship the feature");
      pressKey("Enter", { metaKey: true });
      await flushAsync();

      expect(onPendingAssigneeChange).toHaveBeenCalledWith("agent:a1");
      expect(onRunnerGoalReassign).toHaveBeenCalledWith({
        assigneeAgentId: "a1",
        assigneeUserId: null,
      });
      expect(onRunnerGoalCommand).toHaveBeenCalledWith({
        action: "create",
        objective: "Ship the feature",
      });
      expect(order).toEqual(["reassign", "goal"]);
      expect(onAdd).not.toHaveBeenCalled();
    });

    it("preserves unsupported goal text and shows the provider reason", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          runnerGoalCapability={{
            ...capability,
            availability: "unsupported",
            actions: [],
            reason: "Unsupported by OpenCode.",
          }}
          onRunnerGoalCommand={vi.fn()}
        />,
      );

      typeText("/goal Ship the feature");
      pressKey("Enter", { metaKey: true });
      await flushAsync();

      expect(onAdd).not.toHaveBeenCalled();
      expect(editable().textContent).toBe("/goal Ship the feature");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Unsupported by OpenCode",
      );
    });
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

    it("clears the visible composer but retains an uncertain reload draft while sending", async () => {
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

      expect(onAdd).toHaveBeenCalledWith("queued message", undefined, undefined, undefined, expect.any(String));
      expect(editable().textContent).toBe("");
      expect(localStorage.getItem(draftKey)).toBe("queued message");
      expect(localStorage.getItem(`${draftKey}:submission:v1`)).toContain(
        '"reviewed":false',
      );
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

      expect(onAdd).toHaveBeenCalledWith("first message", undefined, undefined, undefined, expect.any(String));
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

      expect(onAdd).toHaveBeenCalledWith("first message", undefined, undefined, undefined, expect.any(String));
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
        expect(localStorage.getItem(draftKey)).toBe("do not lose this");

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

  it("gives separate identical chat submissions separate receipt identities", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} conversationMode workMode="standard" />);
    typeText("Same message");
    await act(async () => sendButton().click());
    typeText("Same message");
    await act(async () => sendButton().click());
    expect(onAdd.mock.calls).toHaveLength(2);
    expect(onAdd.mock.calls[0][4]).toEqual(expect.any(String));
    expect(onAdd.mock.calls[1][4]).not.toBe(onAdd.mock.calls[0][4]);
  });

  describe("paused task takeover", () => {
    it("allows only standalone /new to resume a paused conversation through the normal composer", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(<TaskChatComposer onAdd={onAdd} conversationMode workMode="standard" pause={{ scope: "leaf" }} />);
      typeText("Keep working");
      expect(sendButton().disabled).toBe(true);
      await act(async () => sendButton().click());
      expect(onAdd).not.toHaveBeenCalled();
      typeText("/new");
      expect(sendButton().disabled).toBe(false);
      await act(async () => sendButton().click());
      expect(onAdd).toHaveBeenCalledWith("/new", undefined, undefined, undefined, expect.any(String));
    });

    it("preserves a typed draft and blocks sending until resume completes", async () => {
      const onAdd = vi.fn();
      const onResume = vi.fn();
      const props = { onAdd, workMode: "standard" as const, draftKey: "paused-draft" };
      act(() => root!.render(<TaskChatComposer {...props} />));
      typeText("Please check mobile too.");
      act(() => root!.render(<TaskChatComposer {...props} pause={{ scope: "leaf", onResume }} />));
      expect(container.querySelector('[contenteditable="true"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
      expect(container.textContent).toContain("Your draft is saved.");
      act(() => container.querySelector("button")!.click());
      expect(onResume).toHaveBeenCalledOnce();
      expect(onAdd).not.toHaveBeenCalled();
      act(() => root!.render(<TaskChatComposer {...props} pause={{ scope: "leaf", pending: true, onResume }} />));
      expect(container.querySelector("button")!.disabled).toBe(true);
      act(() => root!.render(<TaskChatComposer {...props} />));
      expect(editable().textContent).toBe("Please check mobile too.");
      await act(async () => sendButton().click());
      expect(onAdd).toHaveBeenCalledWith("Please check mobile too.", undefined, undefined, undefined, expect.any(String));
    });

    it("takes precedence over pending questions and queued-message edits", () => {
      const onSkip = vi.fn();
      act(() => root!.render(<TaskChatComposer
        onAdd={vi.fn()} workMode="standard"
        pause={{ scope: "subtree" }}
        queuedEdit={{ commentId: "queued", body: "Queued draft" }}
        takeover={{ id: "question", label: "Pending input", pendingCount: 1, content: <button>Answer question</button>, onDismiss: vi.fn(), onSkip }}
      />));
      expect(container.textContent).toContain("Subtree is paused.");
      expect(container.textContent).not.toContain("Answer question");
      expect(container.textContent).not.toContain("Skip");
      expect(container.querySelector('[contenteditable="true"]')).toBeNull();
      expect(container.querySelector("button")!.disabled).toBe(true);
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
    it.each([false, true])("keeps the interaction card visible while sending a normal message (mobile=%s)", async (mobile) => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskChatComposer
          onAdd={onAdd}
          workMode="standard"
          mobile={mobile}
          takeover={{
            id: "question-1",
            label: "Question",
            pendingCount: 1,
            content: <p>Which environment?</p>,
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      typeText("Continue investigating while I decide.");
      expect(container.querySelector('[data-testid="task-chat-composer-takeover"]')?.textContent).toContain("Which environment?");
      await act(async () => sendButton().click());
      expect(onAdd).toHaveBeenCalledWith("Continue investigating while I decide.", undefined, undefined, undefined, expect.any(String));
      expect(container.querySelector('[data-testid="task-chat-composer-takeover"]')?.textContent).toContain("Which environment?");
      expect(editable().textContent).toBe("");
    });

    it("keeps the composer mode shortcut available beneath an open question", () => {
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          onWorkModeChange={vi.fn()}
          takeover={{
            id: "question-1",
            label: "Question",
            pendingCount: 1,
            content: <p>Which environment?</p>,
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );
      pressKey(".", { metaKey: true });
      expect(container.querySelector('[data-testid="task-chat-composer-mode"]')?.textContent).toContain("Plan");
      expect(container.querySelector('[data-testid="task-chat-composer-takeover"]')).not.toBeNull();
    });

    it("shows a separate card above a usable editor and exposes Skip", async () => {
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
      const card = container.querySelector('[data-testid="task-chat-composer-takeover"]')!;
      const composer = container.querySelector('.paperclip-task-chat-composer')!;
      expect(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.querySelector('[data-testid="mdx-editor"]')).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')).not.toBeNull();
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

    it("waits for the submit button on a single-select question", async () => {
      const onSubmit = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "opening-question",
            label: "Questions",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="first-task-opening"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  submitLabel: "Continue",
                  questions: [
                    {
                      id: "first-task-opening",
                      prompt: "What would you like to do?",
                      required: true,
                      answerMode: "single_select",
                      options: [
                        { id: "interview", label: "Interview me" },
                        { id: "task", label: "I have a task in mind" },
                      ],
                    },
                  ],
                }}
                onSubmit={onSubmit}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      const buttons = () =>
        Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
      const interview = buttons().find((button) =>
        button.textContent?.includes("Interview me"),
      );
      expect(interview).not.toBeUndefined();

      // Picking the option only selects it: nothing is sent yet.
      flushSync(() => interview?.click());
      await flushAsync();
      expect(interview?.getAttribute("data-selected")).toBe("true");
      expect(onSubmit).not.toHaveBeenCalled();

      // A required question cannot be skipped.
      expect(
        buttons().find((button) => button.textContent?.trim() === "Skip"),
      ).toBeUndefined();

      // The submit button carries the card's label and does the sending.
      const submit = buttons().find(
        (button) => button.textContent?.trim() === "Continue",
      );
      expect(submit).not.toBeUndefined();
      expect(submit?.disabled).toBe(false);
      flushSync(() => submit?.click());
      await flushAsync();
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
        answers: { "first-task-opening": { selectedOptionIds: ["interview"] } },
      });
    });

    it("advances on Next, preserves answers when going back, and skips optional answers", async () => {
      const onSubmit = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "interview",
            label: "Questions",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="interview"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "env",
                      prompt: "Where?",
                      required: true,
                      answerMode: "single_select",
                      options: [{ id: "staging", label: "Staging" }],
                    },
                    {
                      id: "when",
                      prompt: "When?",
                      required: false,
                      answerMode: "single_select",
                      options: [{ id: "today", label: "Today" }],
                    },
                    {
                      id: "who",
                      prompt: "Who?",
                      required: false,
                      answerMode: "single_select",
                      options: [{ id: "me", label: "Me" }],
                    },
                  ],
                }}
                onSubmit={onSubmit}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      const buttons = () =>
        Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
      const byLabel = (label: string) =>
        buttons().find((button) => button.textContent?.trim() === label);

      // Page 1: required, so no Skip; Next waits for an answer. Answering
      // enables Next but stays put — only Next moves on.
      expect(byLabel("Skip")).toBeUndefined();
      expect(byLabel("Next")?.disabled).toBe(true);
      flushSync(() => byLabel("Staging")?.click());
      await flushAsync();
      expect(container.textContent).toContain("Where?");
      expect(byLabel("Next")?.disabled).toBe(false);
      flushSync(() => byLabel("Next")?.click());
      await flushAsync();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(container.textContent).toContain("When?");
      expect(document.activeElement?.textContent).toBe("When?");

      // Page 2: answer, then Next. Go back to confirm it is saved, then skip.
      flushSync(() => byLabel("Today")?.click());
      await flushAsync();
      flushSync(() => byLabel("Next")?.click());
      await flushAsync();
      expect(container.textContent).toContain("Who?");
      flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')?.click());
      await flushAsync();
      expect(byLabel("Today")?.getAttribute("aria-checked")).toBe("true");
      flushSync(() => byLabel("Skip")?.click());
      await flushAsync();
      expect(container.textContent).toContain("Who?");
      expect(onSubmit).not.toHaveBeenCalled();

      // Last page: primary reads Submit answers and sends everything.
      expect(byLabel("Next")).toBeUndefined();
      flushSync(() => byLabel("Me")?.click());
      await flushAsync();
      flushSync(() => byLabel("Submit answers")?.click());
      await flushAsync();
      expect(onSubmit).toHaveBeenCalledTimes(1);
      const response = onSubmit.mock.calls[0]?.[0];
      expect(response.answers.env).toEqual({ selectedOptionIds: ["staging"] });
      expect(response.answers.when).toBeUndefined();
      expect(response.answers.who).toEqual({ selectedOptionIds: ["me"] });
    });

    it.each(["click", "keyboard"])("records a single choice by %s without leaving the question", async (input) => {
      const onSubmit = vi.fn();
      render(<QuestionForm
        id="selection-modes"
        questionSet={{
          schema: "paperclip.question_set.v1",
          questions: [
            { id: "storage", prompt: "Storage?", required: true, answerMode: "single_select",
              options: [{ id: "sqlite", label: "SQLite" }], customAnswer: { enabled: true } },
            { id: "features", prompt: "Features?", required: true, answerMode: "multi_select",
              options: [{ id: "auth", label: "Sign in" }, { id: "search", label: "Search" }] },
            { id: "notes", prompt: "Notes?", required: false, answerMode: "text" },
          ],
        }}
        initialResponse={{ schema: "paperclip.question_response.v1", answers: { storage: { selectedOptionIds: ["sqlite"] } } }}
        onSubmit={onSubmit}
      />);
      const byLabel = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === label)!;
      // Restoring a selection does not advance. Other needs text first.
      expect(container.textContent).toContain("1 of 3");
      flushSync(() => byLabel("Other").click());
      await flushAsync();
      expect(container.textContent).toContain("1 of 3");
      expect(container.querySelector('[data-testid="question-other-answer-composer"]')).not.toBeNull();
      expect(byLabel("Next").disabled).toBe(true);
      flushSync(() => {
        if (input === "click") byLabel("SQLite").click();
        else byLabel("SQLite").dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      });
      await flushAsync();
      // Answering re-enables Next and closes Other, but the reader stays here.
      expect(container.textContent).toContain("1 of 3");
      expect(container.querySelector('[data-testid="question-other-answer-composer"]')).toBeNull();
      expect(byLabel("SQLite").getAttribute("aria-checked")).toBe("true");
      expect(byLabel("Next").disabled).toBe(false);
      flushSync(() => byLabel("Next").click());
      await flushAsync();
      expect(container.textContent).toContain("2 of 3");
      expect(document.activeElement?.textContent).toBe("Features?");
      flushSync(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", repeat: true, bubbles: true })));
      expect(byLabel("Sign in").getAttribute("aria-checked")).toBe("false");
      flushSync(() => byLabel("Sign in").click());
      flushSync(() => byLabel("Search").click());
      expect(container.textContent).toContain("2 of 3");
      expect(byLabel("Sign in").getAttribute("aria-checked")).toBe("true");
      expect(byLabel("Search").getAttribute("aria-checked")).toBe("true");
      expect(onSubmit).not.toHaveBeenCalled();
      flushSync(() => byLabel("Next").click());
      await flushAsync();
      expect(container.textContent).toContain("3 of 3");
      flushSync(() => byLabel("Submit answers").click());
      await flushAsync();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        schema: "paperclip.question_response.v1",
        answers: { storage: { selectedOptionIds: ["sqlite"] }, features: { selectedOptionIds: ["auth", "search"] } },
      });
    });

    describe("single-choice selection stays on the page", () => {
      const questionSet = {
        schema: "paperclip.question_set.v1" as const,
        questions: ["First", "Second", "Third"].map((prompt) => ({
          id: prompt, prompt, required: true, answerMode: "single_select" as const,
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
          customAnswer: { enabled: true as const },
        })),
      };
      const form = () => (
        <QuestionForm id="stationary" questionSet={questionSet} onSubmit={vi.fn()} />
      );
      const click = (selector: string) => act(() => {
        flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
      });
      const buttonByText = (text: string) =>
        Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === text,
        );

      it("records the answer without navigating", () => {
        render(form());
        click('[role="radio"]');
        expect(container.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).toContain("1 of 3");
        expect(container.textContent).toContain("First");
      });

      it("lets the reader change their mind before moving on", () => {
        render(form());
        click('[role="radio"]');
        const radios = () => Array.from(container.querySelectorAll('[role="radio"]'));
        act(() => { flushSync(() => (radios()[1] as HTMLButtonElement).click()); });
        expect(radios()[0]?.getAttribute("aria-checked")).toBe("false");
        expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).toContain("1 of 3");
      });

      it("advances only on an explicit Next", () => {
        render(form());
        click('[role="radio"]');
        expect(container.textContent).toContain("1 of 3");
        act(() => { flushSync(() => buttonByText("Next")!.click()); });
        expect(container.textContent).toContain("2 of 3");
        expect(document.activeElement?.textContent).toBe("Second");
      });

      it("keeps number-key selection on the same question", () => {
        render(form());
        const page = container.querySelector<HTMLElement>(".tc-question-page")!;
        act(() => {
          flushSync(() => page.dispatchEvent(
            new KeyboardEvent("keydown", { key: "2", bubbles: true }),
          ));
        });
        expect(Array.from(container.querySelectorAll('[role="radio"]'))[1]?.getAttribute("aria-checked"))
          .toBe("true");
        expect(container.textContent).toContain("1 of 3");
      });

      // Selection now clears the form error, which it did not do on the last
      // page before. A failed send has to outlive it: the answers are still
      // unsent, so wiping the message would leave no sign of that at all.
      it("keeps a failed send visible while the reader changes their answer", async () => {
        const onSubmit = vi.fn().mockRejectedValue(new Error("Network unreachable"));
        render(
          <QuestionForm
            id="failed-send"
            questionSet={{
              schema: "paperclip.question_set.v1" as const,
              questions: [{
                id: "only", prompt: "Only", required: true,
                answerMode: "single_select" as const,
                options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
              }],
            }}
            onSubmit={onSubmit}
          />,
        );
        const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
        act(() => { flushSync(() => radios()[0]!.click()); });
        act(() => { flushSync(() => buttonByText("Submit answers")!.click()); });
        await flushAsync();
        expect(onSubmit).toHaveBeenCalledOnce();
        expect(container.textContent).toContain("Network unreachable");
        act(() => { flushSync(() => radios()[1]!.click()); });
        expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).toContain("Network unreachable");
      });

      // The other half of the same rule: the one complaint a selection does
      // answer still goes away when it is answered.
      it("clears a missing-answer complaint once that question is answered", async () => {
        render(
          <QuestionForm
            id="missing-answer"
            questionSet={{
              schema: "paperclip.question_set.v1" as const,
              questions: [
                {
                  id: "First", prompt: "First", required: true,
                  answerMode: "single_select" as const,
                  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
                },
                {
                  id: "Second", prompt: "Second", required: false,
                  answerMode: "single_select" as const,
                  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
                },
              ],
            }}
            onSubmit={vi.fn()}
          />,
        );
        const radios = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
        // The pagination arrow browses without validating, so the reader can
        // reach the end with the first question still blank. Skip on the last
        // question then sends, which is where the complaint comes from.
        click('[aria-label="Next question"]');
        act(() => { flushSync(() => buttonByText("Skip")!.click()); });
        await flushAsync();
        expect(container.textContent).toContain("Question 1 needs an answer");
        act(() => { flushSync(() => radios()[0]!.click()); });
        expect(container.textContent).not.toContain("Question 1 needs an answer");
      });
    });

    it("Skip on the last question submits the other answers", async () => {
      const onSubmit = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "optional-tail",
            label: "Questions",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="optional-tail"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "env",
                      prompt: "Where?",
                      required: false,
                      answerMode: "single_select",
                      options: [{ id: "staging", label: "Staging" }],
                    },
                    {
                      id: "notes",
                      prompt: "Anything else?",
                      required: false,
                      answerMode: "text",
                    },
                  ],
                }}
                onSubmit={onSubmit}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      const byLabel = (label: string) =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.textContent?.trim() === label);
      flushSync(() => byLabel("Staging")?.click());
      await flushAsync();
      flushSync(() => byLabel("Next")?.click());
      await flushAsync();
      expect(container.textContent).toContain("Anything else?");
      flushSync(() => byLabel("Skip")?.click());
      await flushAsync();
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
        answers: { env: { selectedOptionIds: ["staging"] } },
      });
    });

    it("Skip on the last question returns to a required question the arrows walked past", async () => {
      const onSubmit = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "walked-past",
            label: "Questions",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="walked-past"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "env",
                      prompt: "Where?",
                      required: true,
                      answerMode: "single_select",
                      options: [{ id: "staging", label: "Staging" }],
                    },
                    {
                      id: "notes",
                      prompt: "Anything else?",
                      required: false,
                      answerMode: "text",
                    },
                  ],
                }}
                onSubmit={onSubmit}
              />
            ),
            onDismiss: vi.fn(),
            onSkip: vi.fn(),
          }}
        />,
      );

      const byLabel = (label: string) =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.textContent?.trim() === label);
      // The pagination arrow browses past the unanswered required question.
      const arrow = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Next question"]',
      );
      flushSync(() => arrow?.click());
      await flushAsync();
      expect(container.textContent).toContain("Anything else?");

      // Skip here would send; instead the form goes back and says why.
      flushSync(() => byLabel("Skip")?.click());
      await flushAsync();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Where?");
      expect(container.textContent).toContain(
        "Question 1 needs an answer before you can send.",
      );
    });

    it("Cancel closes the takeover and leaves the request pending", async () => {
      const onSubmit = vi.fn();
      const onDismiss = vi.fn();
      const onSkip = vi.fn();
      render(
        <TaskChatComposer
          onAdd={vi.fn()}
          workMode="standard"
          takeover={{
            id: "cancelable",
            label: "Questions",
            pendingCount: 1,
            inlineSkip: true,
            content: (
              <QuestionForm
                id="cancelable"
                questionSet={{
                  schema: "paperclip.question_set.v1",
                  questions: [
                    {
                      id: "env",
                      prompt: "Where?",
                      required: true,
                      answerMode: "single_select",
                      options: [{ id: "staging", label: "Staging" }],
                    },
                  ],
                }}
                onSubmit={onSubmit}
              />
            ),
            onDismiss,
            onSkip,
          }}
        />,
      );

      const cancel = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Cancel");
      expect(cancel).not.toBeUndefined();
      flushSync(() => cancel?.click());
      await flushAsync();
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onSkip).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
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
                      required: false,
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
      expect(staging?.className.split(" ")).toContain("bg-foreground/5");
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

describe("composer Stop", () => {
  function stopButton() { return container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-stop"]'); }

  it("switches Stop to Send with text, whitespace back to Stop, without interrupting on keyboard submit", async () => {
    const onStop = vi.fn(async () => {});
    const onAdd = vi.fn(async () => {});
    render(<TaskChatComposer workMode="standard" onAdd={onAdd} onStop={onStop} stopScope="subtree" />);
    expect(stopButton()?.title).toBe("Stop response");
    pressKey("Enter", { metaKey: true });
    expect(onStop).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    typeText("Check mobile too.");
    expect(stopButton()).toBeNull();
    expect(sendButton().disabled).toBe(false);
    flushSync(() => sendButton().click());
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith("Check mobile too.", undefined, undefined, undefined, expect.any(String));
    expect(onStop).not.toHaveBeenCalled();
    typeText(" \n ");
    expect(stopButton()?.disabled).toBe(false);
  });

  it("blocks duplicate stops and preserves text typed while stopping", async () => {
    let resolve!: () => void;
    const onStop = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} onStop={onStop} />);
    const stop = stopButton()!;
    flushSync(() => { stop.click(); stop.click(); });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(stopButton()?.disabled).toBe(true);
    expect(stopButton()?.getAttribute("aria-label")).toBe("Stopping…");
    typeText("Keep this draft.");
    expect(sendButton().disabled).toBe(false);
    resolve();
    await flushAsync();
    expect(editable().textContent).toBe("Keep this draft.");
  });

  it("reports failure without discarding the draft and permits retry", async () => {
    const onStop = vi.fn().mockRejectedValueOnce(new Error("Unable to stop. Try again.")).mockResolvedValue(undefined);
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} onStop={onStop} />);
    flushSync(() => stopButton()!.click());
    await flushAsync();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to stop. Try again.");
    flushSync(() => stopButton()!.click());
    await flushAsync();
    expect(onStop).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains disabled Send when idle or when stop permission is absent", () => {
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} />);
    expect(stopButton()).toBeNull();
    expect(sendButton().disabled).toBe(true);
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} onStop={vi.fn()} disabled />);
    expect(stopButton()?.disabled).toBe(true);
  });

  it("never turns a queued edit's save action into Stop", () => {
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} onStop={vi.fn()} queuedEdit={{ commentId: "queued", body: "" }} onSaveQueuedEdit={vi.fn()} />);
    expect(stopButton()).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Save queued message");
  });

  it.each([false, true])("keeps attachments in send mode after upload (failed=%s)", async (failed) => {
    let resolve!: (value: never) => void;
    let reject!: (error: Error) => void;
    const onAttachImage = vi.fn(() => new Promise<never>((done, fail) => { resolve = done; reject = fail; }));
    render(<TaskChatComposer workMode="standard" onAdd={vi.fn()} onStop={vi.fn()} onAttachImage={onAttachImage} />);
    pasteFiles([new File(["notes"], "notes.txt", { type: "text/plain" })]);
    await flushAsync();
    expect(stopButton()).toBeNull();
    expect(sendButton().disabled).toBe(true);
    if (failed) reject(new Error("Upload failed"));
    else resolve({ id: "attachment", contentPath: "/notes.txt", originalFilename: "notes.txt" } as never);
    await flushAsync();
    expect(stopButton()).toBeNull();
    expect(sendButton().disabled).toBe(failed);
  });
});
