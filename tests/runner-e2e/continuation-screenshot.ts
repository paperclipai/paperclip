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

/** A task title is mutable while an agent runs. Match the route and visible stable identifier. */
export async function waitForTaskIdentity(page: Page, taskPath: string, identifier: string, timeout = 30_000) {
  await expect(page).toHaveURL(url => url.pathname === taskPath, { timeout });
  const currentIdentifier = page.getByRole("navigation", { name: "breadcrumb" })
    .locator('[aria-current="page"] [data-slot="task-title-identifier"]');
  await expect(currentIdentifier).toBeVisible({ timeout });
  await expect(currentIdentifier).toHaveText(identifier, { timeout });
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
