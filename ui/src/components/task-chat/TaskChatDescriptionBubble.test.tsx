// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same mock the InlineEditor tests use: the rich markdown editor is not
// jsdom-renderable; a textarea keeps the InlineEditor edit-mode contract.
vi.mock("@/components/MarkdownEditor", () => ({
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
        data-testid="description-md-editor"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }),
}));

import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatDescriptionBubble, type TaskChatIssueBrief } from "./TaskChatDescriptionBubble";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeBrief(overrides: Partial<TaskChatIssueBrief> = {}): TaskChatIssueBrief {
  return {
    description: "Ship the widget by **Friday**.",
    author: "human",
    onSave: () => Promise.resolve(),
    ...overrides,
  };
}

describe("TaskChatDescriptionBubble (PAP-375)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(brief: TaskChatIssueBrief) {
    act(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatDescriptionBubble brief={brief} />
        </ThemeProvider>,
      ),
    );
  }

  function click(el: Element | null) {
    expect(el).not.toBeNull();
    act(() => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders a human-created task as the blue user bubble, right-aligned, without an author header", () => {
    render(makeBrief({ createdAt: "2026-08-02T14:34:00.000Z" }));
    const bubble = container.querySelector('[data-testid="task-chat-description-bubble"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute("data-author")).toBe("human");
    expect(bubble?.className).toContain("items-end");
    expect(bubble?.querySelector('[data-testid="task-chat-agent-avatar"]')).toBeNull();
    const body = bubble?.querySelector(".bg-\\(--liveness-blue\\)");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("Ship the widget by");
    // Markdown renders (bold), not raw asterisks.
    expect(body?.querySelector("strong")?.textContent).toBe("Friday");
  });

  it("renders an agent-created task as the agent-side bubble with the avatar author header", () => {
    render(makeBrief({ author: "agent", authorName: "CEO" }));
    const bubble = container.querySelector('[data-testid="task-chat-description-bubble"]');
    expect(bubble?.getAttribute("data-author")).toBe("agent");
    expect(bubble?.className).toContain("items-start");
    expect(bubble?.querySelector('[data-testid="task-chat-agent-avatar"]')).not.toBeNull();
    expect(bubble?.textContent).toContain("CEO");
    expect(bubble?.querySelector(".bg-\\(--bubble-agent\\)")).not.toBeNull();
    expect(bubble?.querySelector(".bg-\\(--liveness-blue\\)")).toBeNull();
  });

  it("renders the live description — a new value shows without remount", () => {
    render(makeBrief());
    render(makeBrief({ description: "Updated brief." }));
    expect(container.textContent).toContain("Updated brief.");
    expect(container.textContent).not.toContain("Ship the widget");
  });

  it("swaps to the InlineEditor on pencil click and returns to the bubble on Escape", () => {
    render(makeBrief());
    click(container.querySelector('[data-testid="task-chat-description-edit"]'));

    const editorWrap = container.querySelector('[data-testid="task-chat-description-editor"]');
    expect(editorWrap).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-description-bubble"]')).toBeNull();
    const textarea = editorWrap?.querySelector<HTMLTextAreaElement>(
      '[data-testid="description-md-editor"]',
    );
    // The editor opens immediately (defaultEditing) on the live description.
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Ship the widget by **Friday**.");

    act(() => {
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector('[data-testid="task-chat-description-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-description-bubble"]')).not.toBeNull();
  });

  it("renders a muted ghost row for an empty description — never an empty bubble — and opens the editor", () => {
    render(makeBrief({ description: "" }));
    expect(container.querySelector('[data-testid="task-chat-description-bubble"]')).toBeNull();
    const ghost = container.querySelector('[data-testid="task-chat-description-ghost"]');
    expect(ghost?.textContent).toContain("Add a description");

    click(ghost);
    expect(container.querySelector('[data-testid="task-chat-description-ghost"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-description-editor"] [data-testid="description-md-editor"]'),
    ).not.toBeNull();
  });

  describe("folding", () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );

    afterEach(() => {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      }
    });

    function stubScrollHeight(value: number) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get: () => value,
      });
    }

    it("folds a long description at the 12-line height with a Show more expander", () => {
      stubScrollHeight(900);
      render(makeBrief({ description: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n") }));
      const content = container.querySelector<HTMLElement>(".fold-curtain__content");
      expect(content?.style.maxHeight).toBe("240px");
      const toggle = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Show more"),
      );
      expect(toggle).not.toBeUndefined();

      click(toggle!);
      expect(container.textContent).toContain("Show less");
      expect(content?.style.maxHeight).toBe("900px");
    });

    it("does not fold a short description", () => {
      stubScrollHeight(120);
      render(makeBrief());
      expect(container.textContent).not.toContain("Show more");
    });
  });
});
