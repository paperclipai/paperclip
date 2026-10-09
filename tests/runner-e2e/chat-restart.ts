import type { Page } from "@playwright/test";

/** Restart the test server without letting the old Vite client race navigation. */
export async function restartChatServer(page: Page, restart: () => Promise<void>) {
  await page.goto("about:blank", { waitUntil: "commit", timeout: 30_000 });
  await restart();
}
