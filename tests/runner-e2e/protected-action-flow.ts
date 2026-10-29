import { expect, type Page } from "@playwright/test";
import { pendingStoryDecision, type StoryInteraction } from "./everyday-decisions.js";

/** A saved decision for this exact connection must exist before any service call. */
export async function decideProtectedActionThroughUi(input: {
  page: Page; rows: StoryInteraction[]; connectionId: string; decline: boolean;
  invocationCount(): number; expectedCallsBefore?: number;
}) {
  const interaction = pendingStoryDecision(input.rows, { kind: "tool", connectionId: input.connectionId });
  expect(input.invocationCount()).toBe(input.expectedCallsBefore ?? 0);
  const dismiss = input.page.getByRole("button", { name: "Dismiss Approve tool action" });
  if (await dismiss.isVisible()) await dismiss.click();
  await input.page.getByRole("button", { name: "Review request", exact: true }).click();
  await input.page.getByRole("button", { name: input.decline ? "Decline" : "Approve & run", exact: true }).click();
  return interaction;
}
