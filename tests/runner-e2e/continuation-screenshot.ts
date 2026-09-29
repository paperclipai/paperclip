import { expect, type Page } from "@playwright/test";

/** Capture only after the requested task's conversation is actually rendered. */
export async function captureLoadedContinuation(
  page: Page,
  title: string,
  capture: () => Promise<void>,
  timeout = 30_000,
  expectedVisibleText?: string,
) {
  await waitForTaskChatRendered(page, title, timeout, expectedVisibleText);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await capture();
}

/** Wait for the persisted task projection before taking a browser screenshot. */
export async function waitForTaskChatRendered(
  page: Page,
  title?: string,
  timeout = 30_000,
  expectedVisibleText?: string,
) {
  const thread = page.getByTestId("task-chat-thread");
  await expect(thread).toBeVisible({ timeout });
  await expect(thread.locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout });
  await expect(thread.getByTestId("task-chat-history-loading")).toHaveCount(0, { timeout });
  if (title !== undefined)
    await expect(thread.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout });
  if (expectedVisibleText !== undefined)
    await expect(thread.getByTestId("task-chat-agent-bubble").filter({ hasText: expectedVisibleText })).toHaveCount(1, { timeout });
}
