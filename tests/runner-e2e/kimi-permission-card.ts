import { expect, type Page } from "@playwright/test";
import { assertSameKimiPending, type KimiLifecyclePending } from "./kimi-lifecycle-evidence.js";

export async function kimiPendingWritePermissionCard(input: {
  page: Page;
  pending: KimiLifecyclePending;
  readPending(): Promise<KimiLifecyclePending>;
}) {
  const { page, pending, readPending } = input;
  assertSameKimiPending(pending, await readPending());
  const prompt = `Change file: ${pending.scope.target}`;
  const card = page.getByTestId("task-chat-runtime-request")
    .filter({ visible: true })
    .filter({ has: page.getByText(prompt, { exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(prompt, { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  assertSameKimiPending(pending, await readPending());
  return card;
}
