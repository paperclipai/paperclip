// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";

const mockSession = vi.hoisted(() => ({ userId: "user-1", pending: null as Promise<{ user: { id: string } } | null> | null }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: () => mockSession.pending ?? Promise.resolve({ user: { id: mockSession.userId } }) },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef<
    { focus: () => void },
    { value: string; onChange: (value: string) => void }
  >(function MarkdownEditorMock(props, ref) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => taRef.current?.focus(),
    }));
    return (
      <textarea
        ref={taRef}
        data-testid="multiline-md-mock"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => (
    <div data-testid="multiline-md-preview">{children}</div>
  ),
}));

import { InlineEditor, queueContainedBlurCommit } from "./InlineEditor";

/** Render as a signed-in user: stored drafts belong to one account. */
function signedIn(userId: string, node: ReactNode) {
  mockSession.userId = userId;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: userId } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/** Enter multiline edit mode by clicking the preview surface. */
function enterMultilineEdit(container: HTMLDivElement) {
  const preview = container.querySelector<HTMLDivElement>('[data-testid="multiline-md-preview"]');
  if (preview) {
    preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Lets React detect a DOM value change on controlled textareas (see React #10140). */
function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  const previous = textarea.value;
  valueSetter?.call(textarea, value);
  const tracker = (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (v: string) => void } })
    ._valueTracker;
  tracker?.setValue(previous);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Matches `queueContainedBlurCommit` (double rAF before commit). Microtasks alone do not run these. */
function flushDoubleRequestAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

describe("InlineEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it.each(["unchanged", "escape", "save", "failure"])("reports single-line editing through %s without an initial closed notification", async (exit) => {
    const onEditingChange = vi.fn();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const onSave = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
    const root = createRoot(container);
    try {
      await act(async () => root.render(signedIn("user-1", <InlineEditor value="Original" onSave={onSave} onEditingChange={onEditingChange} />)));
      expect(onEditingChange).not.toHaveBeenCalled();
      await act(async () => container.querySelector("span")!.click());
      expect(onEditingChange.mock.calls).toEqual([[true]]);
      const input = container.querySelector("textarea")!;
      if (exit === "save" || exit === "failure") act(() => setNativeTextareaValue(input, "Edited title"));
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: exit === "escape" ? "Escape" : "Enter", bubbles: true })));
      if (exit === "save" || exit === "failure") {
        expect(onSave).toHaveBeenCalledWith("Edited title");
        expect(onEditingChange.mock.calls).toEqual([[true]]);
        if (exit === "failure") {
          await act(async () => reject(new Error("Save unavailable")));
          expect(onEditingChange.mock.calls).toEqual([[true]]);
          expect(container.querySelector("textarea")?.value).toBe("Edited title");
          return;
        }
        await act(async () => resolve());
      }
      expect(onEditingChange.mock.calls).toEqual([[true], [false]]);
      expect(container.querySelector("textarea")).toBeNull();
    } finally { act(() => root.unmount()); }
  });

  it("reports a restored single-line edit and retires it before a late save completes", async () => {
    const onEditingChange = vi.fn();
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    localStorage.setItem("paperclip:inline-draft:v2:user-1:restored-callback", JSON.stringify({ version: 1, draft: "Restored title", base: "Original" }));
    const root = createRoot(container);
    try {
      await act(async () => root.render(signedIn("user-1", <InlineEditor value="Original" draftKey="restored-callback" onSave={onSave} onEditingChange={onEditingChange} />)));
      expect(onEditingChange.mock.calls).toEqual([[true]]);
      expect(container.querySelector("textarea")?.value).toBe("Restored title");
      act(() => root.unmount());
      expect(onEditingChange.mock.calls).toEqual([[true], [false]]);
      await act(async () => resolve());
      expect(onEditingChange.mock.calls).toEqual([[true], [false]]);
    } finally { localStorage.removeItem("paperclip:inline-draft:v2:user-1:restored-callback"); }
  });

  it("keeps one edit notification bound to the callback that opened it", async () => {
    const opened = vi.fn();
    const next = vi.fn();
    const onSave = vi.fn();
    const root = createRoot(container);
    try {
      await act(async () => root.render(<InlineEditor value="Original" onSave={onSave} onEditingChange={opened} />));
      await act(async () => container.querySelector("span")!.click());
      await act(async () => root.render(<InlineEditor value="Original" onSave={onSave} onEditingChange={next} />));
      expect(opened.mock.calls).toEqual([[true]]);
      expect(next).not.toHaveBeenCalled();
      await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(opened.mock.calls).toEqual([[true], [false]]);
      expect(next).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });

  it("calls onSave with empty string when nullable and the field is cleared (single-line)", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="hello" nullable onSave={onSave} />);
    });

    const display = container.querySelector("span");
    expect(display).not.toBeNull();
    expect(display?.textContent).toBe("hello");

    act(() => {
      display!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      setNativeTextareaValue(textarea!, "");
    });
    act(() => {
      textarea!.blur();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("");

    act(() => {
      root.unmount();
    });
  });

  it("keeps a single-line edit open with no unhandled rejection when the save fails", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    process.on("unhandledRejection", unhandled);
    const onSave = vi.fn().mockRejectedValue(new Error("Title is too long"));
    const root = createRoot(container);
    act(() => {
      root.render(<InlineEditor value="hello" onSave={onSave} />);
    });
    act(() => {
      container.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector("textarea")!;
    act(() => setNativeTextareaValue(textarea, "hello world"));
    await act(async () => {
      textarea.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSave).toHaveBeenCalledWith("hello world");
    // The text stays in the editor instead of snapping back to the old value.
    expect(container.querySelector("textarea")?.value).toBe("hello world");
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
    process.off("unhandledRejection", unhandled);
    act(() => root.unmount());
  });

  it("restores an unsaved edit and saves it when the server value has not moved", async () => {
    localStorage.setItem("paperclip:inline-draft:v2:user-1:issue-1:description", JSON.stringify({ version: 1, draft: "Typed before reload", base: "Original" }));
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    await act(async () => {
      root.render(signedIn("user-1", <InlineEditor value="Original" multiline draftKey="issue-1:description" onSave={onSave} />));
    });
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]')?.value).toBe("Typed before reload");
    expect(onSave).toHaveBeenCalledWith("Typed before reload");
    act(() => root.unmount());
    localStorage.clear();
  });

  it("restores the next task's stored edit without remounting the editor", async () => {
    localStorage.setItem("paperclip:inline-draft:v2:user-1:issue-b:description", JSON.stringify({ version: 1, draft: "Recovered B", base: "Original B" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    const renderTask = (id: string, onSave: typeof saveA) => root.render(
      <QueryClientProvider client={client}>
        <InlineEditor value={`Original ${id.toUpperCase()}`} multiline draftKey={`issue-${id}:description`} onSave={onSave} />
      </QueryClientProvider>,
    );
    try {
      await act(async () => renderTask("a", saveA));
      await act(async () => renderTask("b", saveB));
      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]')?.value).toBe("Recovered B");
      expect(saveB).toHaveBeenCalledWith("Recovered B");
      expect(saveA).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      localStorage.clear();
      client.clear();
    }
  });

  it("restores an unsaved edit without overwriting a newer server value", async () => {
    localStorage.setItem("paperclip:inline-draft:v2:user-1:issue-2:description", JSON.stringify({ version: 1, draft: "My old edit", base: "Original" }));
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    await act(async () => {
      root.render(signedIn("user-1", <InlineEditor value="Changed by an agent" multiline draftKey="issue-2:description" onSave={onSave} />));
    });
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]')?.value).toBe("My old edit");
    expect(onSave).not.toHaveBeenCalled();
    act(() => root.unmount());
    localStorage.clear();
  });

  it("neither shows nor saves another account's unsaved edit", async () => {
    localStorage.setItem("paperclip:inline-draft:v2:user-1:issue-3:description", JSON.stringify({ version: 1, draft: "Unpublished by user 1", base: "Original" }));
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    await act(async () => {
      root.render(signedIn("user-2", <InlineEditor value="Original" multiline draftKey="issue-3:description" onSave={onSave} />));
    });
    expect(container.textContent).not.toContain("Unpublished by user 1");
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]')?.value ?? "").not.toBe("Unpublished by user 1");
    expect(onSave).not.toHaveBeenCalled();
    act(() => root.unmount());
    localStorage.clear();
  });

  it.each(["user-1", "signed-out"])("keeps typing through the first session lookup (%s)", async (owner) => {
    localStorage.clear();
    localStorage.setItem(`paperclip:inline-draft:v2:${owner}:initial-session`, JSON.stringify({ version: 1, draft: "Earlier saved draft", base: "Original" }));
    let finish!: (session: { user: { id: string } } | null) => void;
    mockSession.pending = new Promise(resolve => { finish = resolve; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <InlineEditor value="Original" draftKey="initial-session" onSave={onSave} />
        </QueryClientProvider>,
      ));
      act(() => container.querySelector("span")!.click());
      const input = container.querySelector("textarea")!;
      act(() => setNativeTextareaValue(input, "Typing while session loads"));
      await act(async () => {
        finish(owner === "signed-out" ? null : { user: { id: owner } });
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(container.querySelector("textarea")).toBe(input);
      expect(input.value).toBe("Typing while session loads");
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(localStorage.getItem(`paperclip:inline-draft:v2:${owner}:initial-session`)).toContain("Typing while session loads");
      });
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
      localStorage.clear();
      mockSession.pending = null;
    }
  });

  it("does not restore typing cancelled before the first session lookup", async () => {
    localStorage.clear();
    localStorage.setItem("paperclip:inline-draft:v2:user-1:cancel-before-session", JSON.stringify({ version: 1, draft: "Original", base: "Original" }));
    let finish!: (session: { user: { id: string } }) => void;
    mockSession.pending = new Promise(resolve => { finish = resolve; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <InlineEditor value="Original" draftKey="cancel-before-session" onSave={vi.fn()} />
        </QueryClientProvider>,
      ));
      act(() => container.querySelector("span")!.click());
      act(() => setNativeTextareaValue(container.querySelector("textarea")!, "Cancelled private text"));
      act(() => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(async () => {
        finish({ user: { id: "user-1" } });
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(container.textContent).not.toContain("Cancelled private text");
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(localStorage.getItem("paperclip:inline-draft:v2:user-1:cancel-before-session")).toBeNull();
      });
    } finally {
      act(() => root.unmount()); client.clear(); localStorage.clear(); mockSession.pending = null;
    }
  });

  it.each([false, true])("isolates a mounted private edit after an account change (multiline=%s)", async (multiline) => {
    mockSession.userId = "user-1";
    localStorage.clear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <InlineEditor value="Original" multiline={multiline} defaultEditing={multiline} draftKey="private-switch" onSave={onSave} />
        </QueryClientProvider>,
      ));
      if (!multiline) act(() => container.querySelector("span")!.click());
      act(() => setNativeTextareaValue(container.querySelector("textarea")!, "Private account A draft"));
      const storedA = localStorage.getItem("paperclip:inline-draft:v2:user-1:private-switch");
      expect(storedA).toContain("Private account A draft");
      mockSession.userId = "user-2";
      await act(async () => {
        client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(container.querySelector("textarea")?.value ?? "").not.toContain("Private account A draft");
      expect(container.textContent).not.toContain("Private account A draft");
      expect(localStorage.getItem("paperclip:inline-draft:v2:user-1:private-switch")).toBe(storedA);
      expect(localStorage.getItem("paperclip:inline-draft:v2:user-2:private-switch")).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
      if (!multiline) act(() => container.querySelector("span")!.click());
      act(() => setNativeTextareaValue(container.querySelector("textarea")!, "Account B edit"));
      expect(localStorage.getItem("paperclip:inline-draft:v2:user-2:private-switch")).toContain("Account B edit");
      expect(localStorage.getItem("paperclip:inline-draft:v2:user-2:private-switch")).not.toContain("Private account A draft");
    } finally {
      act(() => root.unmount());
      client.clear();
      localStorage.clear();
      mockSession.userId = "user-1";
    }
  });

  it("does not call onSave when nullable is false/omitted and the field is cleared", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="hello" onSave={onSave} />);
    });

    const display = container.querySelector("span");
    expect(display).not.toBeNull();

    act(() => {
      display!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      setNativeTextareaValue(textarea!, "");
    });
    act(() => {
      textarea!.blur();
    });

    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("multiline nullable clear uses autosave path (shows Saved after blur)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    act(() => {
      root.render(<InlineEditor value="hello" multiline nullable onSave={onSave} />);
    });

    // Non-empty value renders MarkdownBody preview; click to enter edit mode.
    act(() => {
      enterMultilineEdit(container);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]');
    expect(textarea).not.toBeNull();

    act(() => {
      textarea!.focus();
    });
    act(() => {
      setNativeTextareaValue(textarea!, "");
    });
    act(() => {
      outside.focus();
    });
    await act(async () => {
      await flushDoubleRequestAnimationFrame();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("");
    expect(container.textContent).toContain("Saved");

    act(() => {
      root.unmount();
    });
    outside.remove();
  });

  it("multiline defaults to MarkdownBody preview when value is non-empty, swaps to editor on click", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="Hello world" multiline onSave={onSave} />);
    });

    expect(container.querySelector('[data-testid="multiline-md-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="multiline-md-mock"]')).toBeNull();

    act(() => {
      enterMultilineEdit(container);
    });

    expect(container.querySelector('[data-testid="multiline-md-mock"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="multiline-md-preview"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("enters multiline edit mode from the keyboard preview surface", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="Hello world" multiline onSave={onSave} />);
    });

    const preview = container.querySelector<HTMLElement>('[role="textbox"]');
    expect(preview).not.toBeNull();

    expect(preview?.getAttribute("aria-multiline")).toBe("true");
    expect(preview?.tabIndex).toBe(0);

    act(() => {
      preview!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    expect(container.querySelector('[data-testid="multiline-md-mock"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="multiline-md-preview"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("syncs a new multiline value while focused when the user has not edited locally", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="" multiline onSave={onSave} />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]');
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("");

    act(() => {
      textarea!.focus();
    });

    act(() => {
      root.render(<InlineEditor value="Loaded description" multiline onSave={onSave} />);
    });

    expect(textarea?.value).toBe("Loaded description");

    act(() => {
      root.unmount();
    });
  });

  it("preserves focused multiline local edits when the prop value changes underneath them", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    act(() => {
      root.render(<InlineEditor value="Original" multiline onSave={onSave} />);
    });

    // Non-empty value renders MarkdownBody preview; click to enter edit mode.
    act(() => {
      enterMultilineEdit(container);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="multiline-md-mock"]');
    expect(textarea).not.toBeNull();

    act(() => {
      textarea!.focus();
    });
    act(() => {
      setNativeTextareaValue(textarea!, "Local draft");
    });

    act(() => {
      root.render(<InlineEditor value="Remote update" multiline onSave={onSave} />);
    });

    expect(textarea?.value).toBe("Local draft");

    act(() => {
      root.unmount();
    });
  });
});

describe("queueContainedBlurCommit", () => {
  let container: HTMLDivElement;
  let inside: HTMLTextAreaElement;
  let outside: HTMLButtonElement;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof window.cancelAnimationFrame;

    container = document.createElement("div");
    inside = document.createElement("textarea");
    outside = document.createElement("button");
    container.appendChild(inside);
    document.body.append(container, outside);
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    container.remove();
    outside.remove();
    vi.useRealTimers();
  });

  async function flushFrames() {
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
  }

  it("commits when focus stays outside the editor container", async () => {
    const onCommit = vi.fn();
    const cancel = queueContainedBlurCommit(container, onCommit);

    outside.focus();
    await flushFrames();

    expect(onCommit).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("skips the commit when focus returns inside before the delayed check completes", async () => {
    const onCommit = vi.fn();
    const cancel = queueContainedBlurCommit(container, onCommit);

    outside.focus();
    inside.focus();
    await flushFrames();

    expect(onCommit).not.toHaveBeenCalled();
    cancel();
  });
});
