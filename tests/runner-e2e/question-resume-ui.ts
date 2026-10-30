import { expect, type Page } from "@playwright/test";
import { chatQuestionPresentation } from "./chat-flow.js";

type Row = Record<string, any>;

export async function answerResumeQuestionThroughUi(page: Page, interaction: Row, input: { choice: string } | { text: string }) {
  const set = chatQuestionPresentation(interaction.payload);
  if ("choice" in input) {
    expect(set.questions[0]?.answerMode, "choices must use radio controls").toBe("single_select");
    const options = interaction.payload.questionSet?.questions[0]?.options ?? interaction.payload.questions[0]?.options ?? [];
    expect(new Set(options.map((o: Row) => String(o.label).trim().toLowerCase())).size).toBeGreaterThanOrEqual(2);
    const choice = input.choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("radio", { name: new RegExp(`^${choice}\\b`, "i") }).last().click();
  } else {
    expect(set.questions[0]?.answerMode, "open answers must render a text field, not a choice question").toBe("text");
    await page.getByTestId("question-text-answer-composer").last()
      .locator('[contenteditable="true"],textarea').first().fill(input.text);
  }
  for (let index = 1; index < set.questions.length; index += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
  }
  await page.getByRole("button", { name: set.submitLabel ?? "Submit answers", exact: true }).last().click();
}
