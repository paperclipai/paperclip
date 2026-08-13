// @vitest-environment jsdom

import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentAnnotationThreadWithComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentAnnotationPopover } from "./DocumentAnnotationPopover";

const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/hooks/useDocumentAnnotationMutations", () => ({
  useDocumentAnnotationMutations: () => ({
    createThread: { mutate: mutations.create, isPending: false },
    addReply: { mutate: mutations.reply, isPending: false },
    updateStatus: { mutate: mutations.status, isPending: false },
    mutationError: null,
  }),
}));

vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <p>{children}</p> }));

const pendingAnchor = {
  selector: {
    quote: { exact: "selected plan text", prefix: "", suffix: "" },
    position: { normalizedStart: 0, normalizedEnd: 18, markdownStart: 0, markdownEnd: 18 },
  },
  selectedText: "selected plan text",
};

function thread(): DocumentAnnotationThreadWithComments {
  return {
    id: "thread-1",
    status: "open",
    anchorState: "active",
    selectedText: "selected plan text",
    comments: [{
      id: "comment-1",
      threadId: "thread-1",
      body: "Initial comment",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    }],
  } as unknown as DocumentAnnotationThreadWithComments;
}

describe("DocumentAnnotationPopover", () => {
  let host: HTMLDivElement;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    container = document.createElement("div");
    Object.defineProperties(container, { clientWidth: { value: 500 }, clientHeight: { value: 500 } });
    host.appendChild(container);
    document.body.appendChild(host);
    root = createRoot(container);
  });

  afterEach(async () => {
    await vi.waitFor(() => root.unmount());
    host.remove();
  });

  const render = async (overrides: Partial<React.ComponentProps<typeof DocumentAnnotationPopover>> = {}) => {
    const onClose = vi.fn();
    const props: React.ComponentProps<typeof DocumentAnnotationPopover> = {
      anchorRect: { top: 40, left: 60, width: 100, height: 20 },
      containerRef: createRef<HTMLDivElement>(),
      target: { kind: "issue", issueId: "issue-1", documentKey: "plan" },
      documentKey: "plan",
      baseRevisionId: "rev-1",
      baseRevisionNumber: 1,
      pendingAnchor,
      thread: null,
      focusedCommentId: null,
      onFocusThread: vi.fn(),
      onClose,
      onThreadCreated: vi.fn(),
      ...overrides,
    };
    props.containerRef.current = container;
    root.render(<DocumentAnnotationPopover {...props} />);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="document-annotation-popover"]')).not.toBeNull());
    return { onClose };
  };

  it("anchors compose mode and submits with the keyboard shortcut", async () => {
    await render();
    const card = container.querySelector('[data-testid="document-annotation-popover"]') as HTMLElement;
    expect(card.style.top).toBe("66px");
    expect(card.style.left).toBe("60px");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "Looks good");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await vi.waitFor(() => expect(mutations.create).toHaveBeenCalledWith("Looks good"));
  });

  it("dismisses on Escape and outside pointer down", async () => {
    const first = await render();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(first.onClose).toHaveBeenCalledTimes(2);
  });

  it("replies to and resolves a focused thread", async () => {
    await render({ pendingAnchor: null, thread: thread() });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "A reply");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(textarea.value).toBe("A reply"));
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.includes("Reply"))?.click();
    buttons.find((button) => button.textContent?.includes("Resolve"))?.click();
    await vi.waitFor(() => {
      expect(mutations.reply).toHaveBeenCalledWith({ threadId: "thread-1", body: "A reply" });
      expect(mutations.status).toHaveBeenCalledWith({ threadId: "thread-1", status: "resolved" });
    });
  });
});
