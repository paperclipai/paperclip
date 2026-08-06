// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatBubble } from "./TaskChatBubble";
import type { TaskChatMessageItem } from "./task-chat-model";

describe("TaskChatBubble attachment chips", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function renderMessage(text: string, author: TaskChatMessageItem["author"] = "human") {
    const item: TaskChatMessageItem = { id: "m1", kind: "message", author, text };
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatBubble item={item} />
        </ThemeProvider>,
      ),
    );
  }

  it("renders a file reference as an attachment chip linking to the file", () => {
    renderMessage("Here you go.\n\n[notes.txt](/api/attachments/abc/content) ");

    const group = container.querySelector('[data-testid="task-chat-bubble-attachments"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("notes.txt");
    expect(group?.textContent).toContain("Text");
    const link = group?.querySelector<HTMLAnchorElement>("a[href='/api/attachments/abc/content']");
    expect(link).not.toBeNull();
    // The link-only line left the rendered body; the prose stayed.
    expect(container.textContent).toContain("Here you go.");
    expect(container.textContent).not.toContain("(/api/attachments/abc/content)");
  });

  it("renders a chip-only row when the message body is just the file link", () => {
    renderMessage("[report.pdf](/api/attachments/r1/content)", "agent");

    expect(container.querySelector('[data-testid="task-chat-bubble-attachments"]')).not.toBeNull();
    // No empty bubble is left behind once the only line is chipped.
    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("PDF");
  });

  it("leaves messages without file references untouched", () => {
    renderMessage("Just words and a [normal link](https://example.com).");

    expect(container.querySelector('[data-testid="task-chat-bubble-attachments"]')).toBeNull();
    expect(container.textContent).toContain("Just words");
  });
});

describe("TaskChatBubble accent-bubble text color", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(item: TaskChatMessageItem) {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatBubble item={item} />
        </ThemeProvider>,
      ),
    );
  }

  it("marks the human bubble's markdown as on-accent so prose text follows text-white", () => {
    render({ id: "m1", kind: "message", author: "human", text: "when a new task is created…" });
    const body = container.querySelector(".paperclip-markdown");
    expect(body).not.toBeNull();
    // Without this class the light-mode prose body color reads as black on blue.
    expect(body?.className).toContain("paperclip-markdown-on-accent");
  });

  it("leaves the neutral agent bubble on default prose colors", () => {
    render({ id: "m1", kind: "message", author: "agent", authorName: "CEO", text: "Final reply." });
    const body = container.querySelector(".paperclip-markdown");
    expect(body).not.toBeNull();
    expect(body?.className).not.toContain("paperclip-markdown-on-accent");
  });
});

describe("TaskChatBubble interstitial self-talk (PAP-357)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function renderItem(item: TaskChatMessageItem) {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatBubble item={item} />
        </ThemeProvider>,
      ),
    );
  }

  it("renders nothing — self-talk is ambient signal, suppressed in this view", () => {
    renderItem({
      id: "m1",
      kind: "message",
      author: "agent",
      authorName: "CEO",
      text: "Let me check the **adapter** first.",
      interstitial: true,
      streaming: true,
    });
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-testid="task-chat-agent-avatar"]')).toBeNull();
  });

  it("keeps the bubble and avatar header for non-interstitial agent replies", () => {
    renderItem({
      id: "m1",
      kind: "message",
      author: "agent",
      authorName: "CEO",
      text: "Final reply.",
    });
    expect(container.querySelector('[data-testid="task-chat-interstitial"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-agent-avatar"]')).not.toBeNull();
    expect(container.textContent).toContain("CEO");
  });
});

describe("TaskChatBubble footer line (round 9)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function renderBubble(item: TaskChatMessageItem, attachedTurn?: ReactNode) {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatBubble item={item} attachedTurn={attachedTurn} />
        </ThemeProvider>,
      ),
    );
  }

  it("shows the timestamp always — not only on hover", () => {
    renderBubble({ id: "m1", kind: "message", author: "agent", authorName: "CEO", text: "Done.", timestamp: "2:34 PM" });
    const stamp = [...container.querySelectorAll("span")].find((el) => el.textContent === "2:34 PM");
    expect(stamp).not.toBeNull();
    expect(stamp?.className).not.toContain("opacity-0");
    expect(stamp?.className).not.toContain("group-hover");
  });

  it("renders the attached turn in place of the plain timestamp footer", () => {
    renderBubble(
      { id: "m1", kind: "message", author: "agent", authorName: "CEO", text: "Done.", timestamp: "2:34 PM" },
      <div data-testid="fake-attached-turn">2:34 PM · Worked</div>,
    );
    const slot = container.querySelector('[data-testid="task-chat-bubble-attached-turn"]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('[data-testid="fake-attached-turn"]')).not.toBeNull();
    // The plain footer timestamp is replaced (the attached line carries it).
    const plain = [...container.querySelectorAll("span")].filter((el) => el.textContent === "2:34 PM");
    expect(plain).toHaveLength(0);
  });
});
