// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatReasoningText } from "./TaskChatThinking";

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(body: string) {
  await act(async () => root.render(<TaskChatReasoningText body={body} />));
}

describe("TaskChatReasoningText", () => {
  it("replaces a separately streamed header with a blue label and a 60-character rule", async () => {
    await render("┌─ Reasoning ──────────────────────────────────────────────────────────────────┐");

    const rule = container.querySelector("[aria-label='Reasoning section']")!;
    expect(rule.textContent).toHaveLength(60);
    expect(rule.textContent).not.toMatch(/[┌┐]/);
    expect(rule.querySelector(".text-sky-400")?.textContent).toBe("Reasoning");
  });

  it("replaces a separately streamed footer with a 60-character rule", async () => {
    await render("└──────────────────────────────────────────────────────────────────────────────┘");

    const rule = container.firstElementChild!;
    expect(rule.textContent).toHaveLength(60);
    expect(rule.textContent).not.toMatch(/[└┘]/);
  });

  it("formats a complete frame and removes both corners", async () => {
    await render([
      "┌─ Reasoning ──────────────────────────────────────────────────────────────────┐",
      "Checking the workspace",
      "└──────────────────────────────────────────────────────────────────────────────┘",
    ].join("\n"));

    const frame = container.querySelector("[data-testid='task-chat-reasoning-frame']")!;
    const rules = [...frame.children]
      .map((element) => element.textContent ?? "")
      .filter((text) => text.length === 60);
    expect(frame.textContent).toContain("Checking the workspace");
    expect(frame.textContent).not.toMatch(/[┌┐└┘]/);
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => !/[┌┐└┘]/.test(rule))).toBe(true);
  });
});
