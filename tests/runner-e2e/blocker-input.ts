import { expect, type Page } from "@playwright/test";
import { chatQuestionPresentation } from "./chat-flow.js";

/** The same scope change is supplied through whichever supported input the agent saved. */
export async function answerBlockerThroughUi(page: Page, interaction: Record<string, any>, answer: string) {
  if (interaction.kind === "ask_user_questions") {
    const presentation = chatQuestionPresentation(interaction.payload);
    expect(presentation.questions.length, "saved question set must contain a question").toBeGreaterThan(0);
    // Native closed choices cannot carry this open-ended scope change. Diagnose
    // the saved shape before interacting, including unsupported later pages.
    const closed = presentation.questions.find(q => q.answerMode !== "text" &&
      interaction.payload.questionSet !== undefined && q.customAnswer?.enabled !== true);
    if (closed) throw new Error(`Blocker input cannot save free-form direction: closed-choice question ${closed.id} has no custom answer`);
    for (const [index, question] of presentation.questions.entries()) {
      const text = question.answerMode === "text";
      if (!text) {
        await page.getByRole(question.answerMode === "multi_select" ? "checkbox" : "radio", {
          name: question.customAnswer?.label ?? "Other", exact: true,
        }).last().click();
      }
      const editor = page.getByTestId(text ? "question-text-answer-composer" : "question-other-answer-composer")
        .last().locator('[contenteditable="true"],textarea').first();
      await expect(editor).toBeVisible();
      await editor.fill(answer);
      await page.getByRole("button", {
        name: index === presentation.questions.length - 1 ? presentation.submitLabel ?? "Submit answers" : "Next", exact: true,
      }).last().click();
    }
    return;
  }
  if (!["request_confirmation", "request_checkbox_confirmation"].includes(interaction.kind)) {
    throw new Error(`Unsupported blocker input: ${interaction.kind}`);
  }
  const collectsReason = interaction.payload.rejectRequiresReason || interaction.payload.allowDeclineReason ||
    interaction.payload.declineReasonPlaceholder;
  // A bare rejection wakes the assignee immediately. A later comment cannot
  // safely supply this eval's changed scope, so fail before resolving the card.
  if (!collectsReason) throw new Error("Blocker input cannot save free-form direction: confirmation has no rejection reason field");
  // The user changes scope; never approve a proposed admin/hiring action to pass an eval.
  const reject = page.getByRole("button", { name: interaction.payload.rejectLabel ?? "Reject", exact: true }).last();
  await reject.click();
  await page.locator(`[id="${interaction.id}-reject-reason"]`).fill(answer);
  await reject.click();
  await expect(reject).not.toBeVisible();
}
