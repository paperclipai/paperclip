// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stateful harness so the controlled textarea reflects typed input. */
function Harness(props: Partial<ChatComposerProps> & { initial?: string }) {
  const { initial = "", onChange, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <ChatComposer
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      onSubmit={rest.onSubmit ?? (() => {})}
      {...rest}
    />
  );
}

function typeInput(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ChatComposer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function input() {
    return container.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')!;
  }
  function sendButton() {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  }
  function attachButton() {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]');
  }

  it("renders a bare textarea + send and no attach button without a handler", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness placeholder="Ask anything…" />);
    });
    expect(input()).toBeTruthy();
    expect(input().placeholder).toBe("Ask anything…");
    expect(attachButton()).toBeNull();
    // No formatting toolbar — there is exactly one button (send) when bare.
    expect(container.querySelectorAll("button").length).toBe(1);
    act(() => root.unmount());
  });

  it("shows the attach affordance when onAttachFiles is provided", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onAttachFiles={() => {}} />);
    });
    expect(attachButton()).toBeTruthy();
    act(() => root.unmount());
  });

  it("disables send while empty and enables it once there is text", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    expect(sendButton().disabled).toBe(true);
    act(() => {
      typeInput(input(), "hello");
    });
    expect(sendButton().disabled).toBe(false);
    act(() => root.unmount());
  });

  it("submits on click", () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" />);
    });
    act(() => {
      sendButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('submitKey="enter": plain Enter submits, Shift+Enter does not', () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" submitKey="enter" />);
    });
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('submitKey="mod-enter": plain Enter does not submit, Cmd/Ctrl+Enter does', () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness onSubmit={onSubmit} initial="hi" submitKey="mod-enter" />);
    });
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("singleLine strips newlines from input", () => {
    const onChange = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<Harness singleLine onChange={onChange} />);
    });
    act(() => {
      typeInput(input(), "one\ntwo");
    });
    expect(onChange).toHaveBeenLastCalledWith("one two");
    act(() => root.unmount());
  });

  it("default (multiline) mode soft-wraps and auto-grows instead of clipping (PAP-116)", () => {
    // The conference room composer adopts this default mode. Text must wrap and
    // the box grow up to a cap — never clip horizontally or show an idle scrollbar.
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    const el = input();
    expect(el.getAttribute("wrap")).toBe("soft");
    expect(el.className).toContain("overflow-y-auto");
    expect(el.className).toContain("max-h-[200px]");
    expect(el.className).not.toContain("whitespace-nowrap");
    expect(el.className).not.toContain("overflow-x-auto");
    act(() => root.unmount());
  });

  it("singleLine mode clips to one row (opt-in only)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness singleLine />);
    });
    const el = input();
    expect(el.getAttribute("wrap")).toBe("off");
    expect(el.className).toContain("whitespace-nowrap");
    expect(el.className).toContain("max-h-[22px]");
    act(() => root.unmount());
  });

  it('tone="planning" is reflected on the container', () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness tone="planning" />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]');
    expect(box?.getAttribute("data-tone")).toBe("planning");
    act(() => root.unmount());
  });

  it('defaults to the opaque "card" surface', () => {
    // PAP-131: surface is opt-in — existing adopters keep the bg-card box.
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]')!;
    expect(box.getAttribute("data-surface")).toBe("card");
    expect(box.className).toContain("bg-card");
    expect(box.className).not.toContain("backdrop-blur");
    // Rounded corners are shared chrome on both surfaces.
    expect(box.className).toContain("rounded-xl");
    act(() => root.unmount());
  });

  it('surface="translucent" applies the task glass recipe and keeps shared chrome (PAP-131)', () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness surface="translucent" />);
    });
    const box = container.querySelector('[data-testid="chat-composer"]')!;
    expect(box.getAttribute("data-surface")).toBe("translucent");
    // Glass recipe — mirrors the task-comments composer shell.
    expect(box.className).toContain("bg-background/95");
    expect(box.className).toContain("supports-[backdrop-filter]:bg-background/85");
    expect(box.className).toContain("backdrop-blur");
    expect(box.className).toContain("shadow-[0_-12px_28px_rgba(15,23,42,0.08)]");
    expect(box.className).toContain("dark:shadow-[0_-12px_28px_rgba(0,0,0,0.28)]");
    expect(box.className).not.toContain("bg-card");
    // Shared chrome survives: rounded-xl corners + neutral focus darkening.
    expect(box.className).toContain("rounded-xl");
    expect(box.className).toContain("focus-within:border-muted-foreground/40");
    act(() => root.unmount());
  });

  it("translucent surface keeps the drag-over attach layering", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness surface="translucent" onAttachFiles={() => {}} />);
    });
    const box = container.querySelector<HTMLDivElement>('[data-testid="chat-composer"]')!;
    act(() => {
      const dataTransfer = { types: ["Files"], dropEffect: "none" };
      const evt = new Event("dragenter", { bubbles: true }) as DragEvent & {
        dataTransfer: typeof dataTransfer;
      };
      Object.defineProperty(evt, "dataTransfer", { value: dataTransfer });
      box.dispatchEvent(evt);
    });
    expect(container.querySelector('[data-testid="chat-composer-drop-overlay"]')).toBeTruthy();
    act(() => root.unmount());
  });
});
