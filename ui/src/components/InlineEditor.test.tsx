// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

import { InlineEditor } from "./InlineEditor";

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
});
