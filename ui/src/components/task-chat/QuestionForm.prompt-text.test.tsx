// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { QuestionForm } from "./QuestionForm";
vi.mock("./TaskChatRichInput", () => ({ TaskChatRichInput: () => <textarea /> }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) =>
    <div data-markdown className={className}>{children}</div>,
}));

const prompt = "Why this question:\n\n- first situation\n- second situation";

it("renders a multi-paragraph prompt at the card's text size and in body weight", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QuestionForm id="q" presentation="decision" questionSet={{ schema: "paperclip.question_set.v1", description: "- context point", questions: [
      { id: "one", prompt, answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "two", prompt: "Second?", answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    ] }} onSubmit={vi.fn()} />));
    const promptBlock = [...host.querySelectorAll<HTMLElement>("[data-markdown]")].find((node) => node.textContent === prompt);
    expect(promptBlock).toBeDefined();
    // The shared Markdown body sets its own 15px size; the prompt must follow the card instead.
    expect(promptBlock!.className).toContain("paperclip-markdown-inherit-size");
    // A multi-paragraph prompt reads as body text, not as one bold heading.
    expect(promptBlock!.closest(".font-medium")).toBeNull();
    // The question-set context sits in a smaller, muted container; it must not outgrow the prompt.
    const contextBlock = [...host.querySelectorAll<HTMLElement>("[data-markdown]")].find((node) => node.textContent === "- context point");
    expect(contextBlock?.className).toContain("paperclip-markdown-inherit-size");
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});

it("keeps a one-line prompt in the question's medium weight", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QuestionForm id="q" questionSet={{ schema: "paperclip.question_set.v1", questions: [
      { id: "one", prompt: "Which one?", answerMode: "single_select", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    ] }} onSubmit={vi.fn()} />));
    const promptBlock = [...host.querySelectorAll<HTMLElement>("[data-markdown]")].find((node) => node.textContent === "Which one?");
    expect(promptBlock?.className).toContain("paperclip-markdown-inherit-size");
    expect(promptBlock?.closest(".font-medium")).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});
