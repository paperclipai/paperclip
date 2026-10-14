// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipQuestionResponse, PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { QuestionForm } from "./QuestionForm";

vi.mock("./TaskChatRichInput", () => ({
  TaskChatRichInput: ({ value, onChange }: { value: string; onChange(value: string): void }) =>
    <textarea aria-label="Answer" value={value} onChange={event => onChange(event.target.value)} />,
}));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

const questionSet: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [
  { id: "draft", prompt: "Edit the draft", required: true, answerMode: "text", initialText: "  Draft\n漢字\n" },
] };

describe("QuestionForm initial text", () => {
  let container: HTMLDivElement;
  let root: Root;
  const submit = vi.fn();
  beforeEach(() => { localStorage.clear(); submit.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
  const input = () => container.querySelector("textarea")!;
  async function render(set = questionSet, initialResponse?: PaperclipQuestionResponse) {
    await act(async () => root.render(<QuestionForm id="edit" questionSet={set} initialResponse={initialResponse} draftKey="question-initial-text" onSubmit={submit} />));
  }
  async function edit(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function remount(set = questionSet) { await act(async () => root.unmount()); root = createRoot(container); await render(set); }
  it("shows exact editable text without sending until the operator submits", async () => {
    await render();
    expect(input().value).toBe("  Draft\n漢字\n");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: { draft: { text: "  Draft\n漢字\n" } } });
  });
  it("preserves edits through a refreshed request and reload instead of reapplying a default", async () => {
    await render(); await edit("Operator edit\n");
    const refreshed = { ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText: "New provider default" }] };
    await render(refreshed); expect(input().value).toBe("Operator edit\n");
    await remount(refreshed); expect(input().value).toBe("Operator edit\n");
    expect(submit).not.toHaveBeenCalled();
  });
  it("retains an explicitly cleared draft and required validation across reload", async () => {
    await render(); await edit(""); await remount();
    expect(input().value).toBe("");
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
  it("isolates pending requests with the same field ids and restores each edited draft when switching back", async () => {
    async function showRequest(id: string, initialText: string) {
      const set = { ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText }] };
      await act(async () => root.render(
        <QuestionForm id={id} questionSet={set} draftKey={`question:${id}`} onSubmit={submit} />,
      ));
    }
    const storedText = (id: string) => JSON.parse(localStorage.getItem(`question:${id}`)!).answers.draft.text;

    await showRequest("request-a", "Provider draft A");
    await edit("Operator edit A");
    await showRequest("request-b", "Provider draft B");
    expect(input().value).toBe("Provider draft B");
    expect(storedText("request-a")).toBe("Operator edit A");
    expect(storedText("request-b")).toBe("Provider draft B");
    await edit("Operator edit B");

    await showRequest("request-a", "Refreshed provider draft A");
    expect(input().value).toBe("Operator edit A");
    await showRequest("request-b", "Refreshed provider draft B");
    expect(input().value).toBe("Operator edit B");
    expect(storedText("request-a")).toBe("Operator edit A");
    expect(storedText("request-b")).toBe("Operator edit B");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: { draft: { text: "Operator edit B" } } });
  });

  it("prefers an existing response and keeps text constraints on defaults", async () => {
    await render(questionSet, { schema: "paperclip.question_response.v1", answers: { draft: { text: "Existing answer" } } });
    expect(input().value).toBe("Existing answer");
    await act(async () => root.unmount()); localStorage.clear(); root = createRoot(container);
    await render({ ...questionSet, questions: [{ ...questionSet.questions[0]!, initialText: "bad", textValidation: { minLength: 5 } }] });
    expect(input().value).toBe("bad");
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Submit answers")!.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
