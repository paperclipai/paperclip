// @vitest-environment jsdom

import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatComposer } from "./TaskChatComposer";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom has no object-URL support; the composer uses it for image previews.
  URL.createObjectURL = vi.fn(() => "blob:mock-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
});

function render(ui: ReactElement) {
  flushSync(() => root!.render(ui));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  flushSync(() => {
    nativeSetter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(
  textarea: HTMLTextAreaElement,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
) {
  flushSync(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ...modifiers, bubbles: true, cancelable: true }),
    );
  });
}

function pressCmdEnter(textarea: HTMLTextAreaElement) {
  pressEnter(textarea, { metaKey: true });
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function input() {
  return container.querySelector<HTMLTextAreaElement>('[data-testid="task-chat-composer-input"]')!;
}

function sendButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
}

describe("TaskChatComposer", () => {
  it("submits the trimmed body on Cmd+Enter and clears the draft", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    expect(sendButton().disabled).toBe(true);
    setTextareaValue(input(), "  hello there  ");
    expect(sendButton().disabled).toBe(false);

    pressCmdEnter(input());
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("hello there", undefined, undefined);
    expect(input().value).toBe("");
  });

  it("submits on Ctrl+Enter", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    setTextareaValue(input(), "hello");
    pressEnter(input(), { ctrlKey: true });
    await flushAsync();

    expect(onAdd).toHaveBeenCalledWith("hello", undefined, undefined);
  });

  it("does not submit on plain Enter or Shift+Enter (newline stays in the draft)", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<TaskChatComposer onAdd={onAdd} workMode="standard" />);

    setTextareaValue(input(), "line one");
    pressEnter(input());
    pressEnter(input(), { shiftKey: true });
    await flushAsync();

    expect(onAdd).not.toHaveBeenCalled();
    expect(input().value).toBe("line one");
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

    flushSync(() => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(chip.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(chip.textContent).toContain("Plan");

    setTextareaValue(input(), "do the plan");
    pressCmdEnter(input());
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

    setTextareaValue(input(), "wake up");
    pressCmdEnter(input());
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

  it("uploads pasted files via onAttachImage and inserts the reference into the draft", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/shot.png",
      originalFilename: "shot.png",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file] } });
    flushSync(() => {
      input().dispatchEvent(paste);
    });
    await flushAsync();

    expect(onAttachImage).toHaveBeenCalledWith(file);
    expect(input().value).toContain("![shot.png](/attachments/shot.png)");
    const chips = container.querySelector('[data-testid="task-chat-composer-attachments"]');
    expect(chips?.textContent).toContain("shot.png");
  });

  it("shows an object-URL thumbnail for a pasted image attachment", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/shot.png",
      originalFilename: "shot.png",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [file] } });
    flushSync(() => {
      input().dispatchEvent(paste);
    });
    await flushAsync();

    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    const thumb = container.querySelector<HTMLImageElement>(
      '[data-testid="task-chat-composer-attachments"] img',
    );
    expect(thumb?.src).toBe("blob:mock-preview");
    expect(thumb?.alt).toBe("");
  });

  it("renders no thumbnail for non-image attachments and revokes previews on unmount", async () => {
    const onAttachImage = vi.fn().mockResolvedValue({
      contentPath: "/attachments/notes.txt",
      originalFilename: "notes.txt",
    });
    render(<TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />);

    const image = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const text = new File(["plain"], "notes.txt", { type: "text/plain" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [image, text] } });
    flushSync(() => {
      input().dispatchEvent(paste);
    });
    await flushAsync();

    // Only the image chip carries a thumbnail; the text chip stays text-only.
    const chips = container.querySelector('[data-testid="task-chat-composer-attachments"]')!;
    expect(chips.textContent).toContain("notes.txt");
    expect(chips.querySelectorAll("img")).toHaveLength(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    flushSync(() => root!.unmount());
    root = null;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-preview");
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
});
