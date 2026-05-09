// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("marks multiline preview textboxes as multiline", () => {
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
