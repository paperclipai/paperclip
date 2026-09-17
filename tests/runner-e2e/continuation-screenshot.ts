import { expect, type Page } from "@playwright/test";

/** Capture only after the requested task's conversation is actually rendered. */
export async function captureLoadedContinuation(
  page: Page,
  title: string,
  capture: () => Promise<void>,
  timeout = 30_000,
) {
  const thread = page.getByTestId("task-chat-thread");
  await expect(thread).toBeVisible({ timeout });
  await expect(thread.locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout });
  await expect(thread.getByTestId("task-chat-history-loading")).toHaveCount(0, { timeout });
  await expect(thread.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await capture();
}
