import { expect, type Page } from "@playwright/test";
import { chatQuestionPresentation } from "./chat-flow.js";

type Row = Record<string, any>;

export async function answerResumeQuestionThroughUi(page: Page, interaction: Row, input: { choice: string } | { text: string; allowProviderCustomAnswer?: boolean }) {
  const set = chatQuestionPresentation(interaction.payload);
  if ("choice" in input) {
    expect(set.questions[0]?.answerMode, "choices must use radio controls").toBe("single_select");
    const options = interaction.payload.questionSet?.questions[0]?.options ?? interaction.payload.questions[0]?.options ?? [];
    expect(new Set(options.map((o: Row) => String(o.label).trim().toLowerCase())).size).toBeGreaterThanOrEqual(2);
    const choice = input.choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("radio", { name: new RegExp(`^${choice}\\b`, "i") }).last().click();
  } else {
    const field = set.questions[0];
    const custom = field?.answerMode !== "text";
    if (custom) {
      expect(input.allowProviderCustomAnswer && interaction.payload.questionSet && field?.answerMode === "single_select"
        && field.customAnswer?.enabled === true, "the canonical provider form must explicitly permit a written reference").toBeTruthy();
      await page.getByRole("radio", { name: field!.customAnswer?.label ?? "Other", exact: true }).last().click();
    }
    await page.getByTestId(custom ? "question-other-answer-composer" : "question-text-answer-composer").last()
      .locator('[contenteditable="true"],textarea').first().fill(input.text);
  }
  for (let index = 1; index < set.questions.length; index += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
  }
  await page.getByRole("button", { name: set.submitLabel ?? "Submit answers", exact: true }).last().click();
}
