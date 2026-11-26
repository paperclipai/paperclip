// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { QuestionForm } from "./QuestionForm";
vi.mock("./TaskChatRichInput", () => ({ TaskChatRichInput: () => <textarea /> }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
it("the existing question form submits the exact saved-value choice only after a human selection and submit", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), submit = vi.fn();
  try {
    await act(async () => root.render(<QuestionForm id="bound-question" questionSet={{ schema: "paperclip.question_set.v1", submitLabel: "Confirm value", questions: [
      { id: "saved", prompt: "Have you saved your own value?", answerMode: "single_select", required: true, options: [
        { id: "yes", label: "Yes", description: "My personal value is saved." }, { id: "later", label: "Not yet" },
      ] },
    ] }} onSubmit={submit} />));
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('[id="foreign-question-saved-yes"]')).toBeNull();
    const option = host.querySelector<HTMLButtonElement>('[id="bound-question-saved-yes"]'); expect(option).not.toBeNull();
    await act(async () => option!.click()); expect(submit).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "Confirm value"); expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ schema: "paperclip.question_response.v1", answers: { saved: { selectedOptionIds: ["yes"] } } });
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});
