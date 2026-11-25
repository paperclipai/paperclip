import type { Page } from "@playwright/test";

export async function seedReturningAnnouncementVisit(page: Page) {
  await page.addInitScript(() => {
    const key = "paperclip.board-visit.v1:local-board";
    if (!localStorage.getItem(key)) localStorage.setItem(key, String(Date.now() - 31 * 60_000));
  });
}
